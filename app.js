console.log("Starting infight server")

require('dotenv').config()
const authSettings = {
  discord_oauth2_client_id: process.env.DISCORD_OAUTH2_CLIENT_ID,
  discord_oauth2_client_secret: process.env.DISCORD_OAUTH2_CLIENT_SECRET,
  discordCallbackPath: '/auth/discord/callback',
  discordToken: process.env.DISCORD_BOT_TOKEN,
  sessionSecret: process.env.SESSION_SECRET,
  uiUrl: process.env.UI_BASE_URL,
  apiUrl: process.env.API_BASE_URL
}

const express = require('express')
const app = express()
const cors = require('cors')
const port = 3000
app.use(express.json());
app.use(cors())


// an object containing Server Sent Event (SSE) broadcast channels for each game
const { createSession, createChannel } = require("better-sse");
const InfightNotifier = {
  sseChannels: {},
  disco: null,
  async addToChannel(req, res) { //saves an HTTP connection to a particular channel for later notification
    const session = await createSession(req, res);
    const gameId = req.params.gameId
    if (!this.sseChannels[gameId]) {
      this.sseChannels[gameId] = createChannel()
    }
    this.sseChannels[gameId].register(session)

    session.push("You're connected to game events");
  },
  async notify(game, msg) { //sends a string out to all channels for a game
    //tell discord
    const guild = await infightDB.sequelize.models.Guild.findByPk(game.GuildId)
    const guildChannel = this.disco.channels.cache.get(guild.gameChannelId)
    guildChannel.send(msg)

    //tell SSE
    if (this.sseChannels[game.id]) {
      this.sseChannels[game.id].broadcast(msg)
    }
  },
  async notifyGameId(gameId, msg) {
    const game = await infightDB.models.Game.getByPk(gameId)
    this.notify(game, msg)
  },
  async notifyGuildId(guildId, msg) {
    const guild = await infightDB.sequelize.models.Guild.findByPk(guildId)
    const guildChannel = this.disco.channels.cache.get(guild.gameChannelId)
    guildChannel.send(msg)
  }
}

const { Op } = require('sequelize')
const infightDB = require('./models/infightDB')
infightDB.init()
infightDB.sequelize.models.Game.notifier = InfightNotifier // add the notifier to the Game model so its available to Games
infightDB.sequelize.models.Guild.notifier = InfightNotifier // add the notifier to the Guild model so its available to Guilds

const infightLogin = require("./auth/login")(app, authSettings, infightDB)
const verifyToken = require("./auth/tokenAuthMiddleware")


const ifDisco = require('./discord/ifDiscord')(infightDB)
InfightNotifier.disco = ifDisco // attach discord to the notifier

app.get('/', (req, res) => {
  res.send('Hello from the infight api!')
})

app.get('/myTeams', verifyToken, async (req, res) => {

  const player = await infightDB.Player.findByPk(req.user.id)
  if (player === null) {
    res.send('404')
  }

  let playerGuilds = await infightDB.PlayerGuild.findAll({
    where: {
      PlayerId: {
        [Op.eq]: req.user.id
      },
    },
    include: [{
      model: infightDB.Guild
    }]
  })

  res.send(playerGuilds)
})

app.post('/guild/:teamId/optIn', verifyToken, async (req, res) => {
  try {
    const pg = await infightDB.PlayerGuild.findOne({
      where: {
        GuildId: req.params.teamId,
        PlayerId: req.user.id
      }
    })

    if (pg != null) {
      pg.changePlayerOptIn(req.body.optIn)
      await pg.save()
    }
    res.send('nice')
  } catch (error) {
    res.status(404).send(error)
  }
})

app.get('/guild/:teamId', async (req, res) => {
  try {
    const pg = await infightDB.Guild.findOne({
      where: {
        id: req.params.teamId
      },
      include: [{
        model: infightDB.Game,
        include: [{
          model: infightDB.GamePlayer,
          include: {
            model: infightDB.Player // game winner
          }
        },]
      }, {
        model: infightDB.Player
      }
      ],
      order: [
        [infightDB.Game, 'startTime', 'DESC'],
        [infightDB.Game, infightDB.GamePlayer, 'winPosition', 'ASC']
      ],
    })
    if (pg == null) {
      throw new Error("Guild not found")
    }
    res.send(pg)
  } catch (error) {
    res.status(404).send(error)
  }
})

app.post('/guild/:teamId/settings', verifyToken, async (req, res) => {
  try {
    //confirm current player is an admin
    const adminPlayerGuild = await infightDB.PlayerGuild.findOne({
      where: {
        GuildId: req.params.teamId,
        PlayerId: req.user.id,
        isAdmin: true
      }
    })
    if (adminPlayerGuild === null) {
      throw new Error("You are not an admin of this guild")
    }


    const pg = await infightDB.Guild.findOne({
      where: {
        id: req.params.teamId
      }
    })
    if (pg == null) {
      throw new Error("Guild not found")
    }

    pg.boardSize = req.body.boardSize
    pg.actionTimerMinutes = req.body.actionTimerMinutes
    pg.minimumPlayerCount = req.body.minimumPlayerCount

    await pg.save()
    await pg.shouldStartCurrentGame()

    return res.send(pg)
  } catch (error) {
    res.status(404).send(error.message)
  }
})

app.get('/games/:teamId/:gameId', async (req, res) => {

  //check if we got a good id
  if (!req.params.teamId) {
    return res.status(404).send(new Error("Invalid teamId"))
  }

  //check if we got a good id
  if (!req.params.gameId || Number.isNaN(Number.parseInt(req.params.gameId))) {
    return res.status(404).send(new Error("Invalid gameId"))
  }

  const game = await infightDB.Game.findByPk(req.params.gameId, {
    include: [{
      model: infightDB.GamePlayer,
      include: {
        model: infightDB.Player
      }
    }, {
      model: infightDB.Guild
    }
    ]
  });
  if (!game) {
    return res.status(404).send("Game not found")
  }

  res.send(game)
})

app.get("/games/:teamId/:gameId/events", async (req, res) => {
  InfightNotifier.addToChannel(req, res)
});

//this is a development endpoint to kill a game
app.delete('/games/:teamId/:gameId', async (req, res) => {

  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).send('This endpoint is only available in development mode');
  }

  //check if we got a good id
  if (!req.params.teamId) {
    return res.status(404).send(new Error("Invalid teamId"))
  }

  //check if we got a good id
  if (!req.params.gameId) {
    return res.status(404).send(new Error("Invalid gameId"))
  }

  const game = await infightDB.Game.findByPk(req.params.gameId, { include: { all: true } });
  game.cancelAndStartNewGame()

  res.send(game)
})

//this is a development endpoing to start a game before it automatically does
app.post('/games/:teamId/:gameId/start', async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).send('This endpoint is only available in development mode');
  }

  const game = await infightDB.Game.findByPk(req.params.gameId);
  if (!game) {
    return res.status(404).send("Invalid gameId")
  }

  try {
    const result = await game.startGame()
    res.send(game)
  } catch (error) {
    return res.status(404).send(error)
  }

})

//this is a development endpoing to start a game before it automatically does
app.post('/games/:teamId/:gameId/spawnEnemy', async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).send('This endpoint is only available in development mode');
  }

  const game = await infightDB.Game.findByPk(req.params.gameId);
  if (!game) {
    return res.status(404).send("Invalid gameId")
  }

  try {

    if (req.body.enemyType == 'lootGoblin') {
      await game.addLootGoblin()
    }

    res.send(game)
  } catch (error) {
    return res.status(404).send(error)
  }

})

//this is a development endpoint to force a tick before it automatically does one
app.post('/games/:teamId/:gameId/tick', async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).send('This endpoint is only available in development mode');
  }

  const game = await infightDB.Game.findByPk(req.params.gameId)
  if (null == game) {
    return res.status(400).send('Game not found')
  }
  try {
    const result = await game.doTick()
    res.send(result)
  } catch (error) {
    res.status(400).send(error)
  }
})


app.post('/games/:teamId/:gameId/act', verifyToken, async (req, res) => {

  const action = req.body.action
  const targetX = req.body.targetX
  const targetY = req.body.targetY

  if (!['move', 'shoot', 'giveAP', 'giveHP', 'upgrade', 'heal', 'juryVote', 'startFire', 'shove'].includes(action)) {
    return res.status(400).send("Action '" + action + "' not supported")
  }

  const player = await infightDB.Player.findByPk(req.user.id)
  if (player === null) {
    return res.status(404).send("User not logged in")
  }

  const game = await infightDB.Game.findByPk(req.params.gameId, { include: { all: true } });
  if (!game) {
    return res.status(404).send("Invalid gameId")
  }
  try {

    const result = await game.doMove(player, action, targetX, targetY)
    res.send(result)

  } catch (error) {
    console.log("Action failed", error)
    return res.status(400).send(error.message)
  }

})

// repeating check to see what games are due for an action point distro
setInterval(async () => {
  //console.log("Doing a tick scan")
  infightDB.sequelize.models.Game.tickGamesNeedingTick()
}, 1000 * 25) //how often to query for games that need AP distro

// repeating check to see what games are due to start
setInterval(async () => {
  //console.log("Doing a start scan")
  infightDB.sequelize.models.Game.startGamesNeedingToStart()
}, 1000 * 30) //how often to query for games that need AP distro

// create enemies randomly
setInterval(async () => {
  //console.log("Doing a start scan")
  //infightDB.sequelize.models.Game.sprinkleEnemies()
}, 1000 * 60) //how often to query for games that need AP distro

app.listen(port, () => {
  console.log(`Infight server listening on port ${port}`)
})