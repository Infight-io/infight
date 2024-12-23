const { Sequelize, DataTypes, Model, Op } = require('sequelize')
const { Stats } = require('./StatTracker')
const GamePlayer = require('./GamePlayer')
const StatTracker = require('./StatTracker')

module.exports = function (sequelize) {

    class Game extends Model {
        notifier = null

        async addPlayer(playerId) {
            if (this.status != 'new') {
                throw new Error("Cannot add a player if the game's not new")
            }
            const existingPlayers = await this.sequelize.models.GamePlayer.findAll({
                where: {
                    PlayerId: playerId,
                    GameId: this.id
                },
            })
            if (existingPlayers.length == 1) {
                return existingPlayers[0]
            }

            const gp = this.sequelize.models.GamePlayer.build({
                GameId: this.id,
                PlayerId: playerId
            })
            await gp.save()
            return gp
        }
        async removePlayer(playerId) {
            if (this.status != 'new') {
                throw new Error("Cannot remove a player if the game's not new")
            }
            const existingPlayer = await this.sequelize.models.GamePlayer.findOne({
                where: {
                    PlayerId: playerId,
                    GameId: this.id
                },
            })
            if (existingPlayer != null) {
                await existingPlayer.destroy()
            }
            return
        }

        async checkShouldStartGame() {
            if (this.status != 'new') return

            const gamePlayers = await this.getGamePlayers()
            if (gamePlayers.length >= this.minimumPlayerCount && this.startTime == null) {
                const thisMoment = new Date()
                this.startTime = new Date(+new Date(thisMoment) + (5 * 60 * 1000)) // start in 5 min
                await this.save()
                this.notify("🎉 Game has enough players! [The new game](" + this.getUrl() + ") will start soon! ⏳ Start conspiring! 🕵️ More people can still `/infight-join` until game time!")
                return
            }

            if (gamePlayers.length < this.minimumPlayerCount && this.startTime != null) {
                this.startTime = null
                await this.save()
                this.notify("⚠️ Game can't start! Player count dipped below **minimum of " + this.minimumPlayerCount + "**. Recruit a player to start the game!")
                return
            }

            console.log('Should Start Game fell through the conditionals')
        }

        async #findClearSpace(gamePlayers) {
            let loopCount = 0
            let foundClearSpace = false
            while (!foundClearSpace) {
                loopCount++
                if (loopCount > 100) {
                    throw new Error("findClearSpace ran too long")
                }

                foundClearSpace = true

                const newPos = [
                    Math.floor(Math.random() * this.boardWidth),
                    Math.floor(Math.random() * this.boardHeight)
                ]

                //did we crash into a player?
                if (this.isPlayerInSpace(gamePlayers, newPos)) {
                    foundClearSpace = false
                    continue
                }

                //did we crash into an object?
                if (this.isObjectInSpace(newPos)) {
                    foundClearSpace = false
                    continue
                }

                if (foundClearSpace) {
                    return newPos
                }

            }
        }

        async removeObjectInSpace(position, type = null) {
            for (let i = 0; i < this.boardObjectLocations.length; i++) {
                const boardObject = this.boardObjectLocations[i];
                if (boardObject.x == position[0] && boardObject.y == position[1]) {
                    if (type == null || boardObject.type == type) {
                        this.boardObjectLocations.splice(i, 1);
                        this.changed('boardObjectLocations', true); // deep change operations in a json field aren't automatically detected by sequelize
                        await this.save();
                        return;
                    }
                }
            }
        }

        isObjectInSpace(newPos, specificType = null) {
            let objArray = this.getObjectsInSpace(newPos)
            if (objArray.length == 0) return false
            if (specificType != null) {
                for (let i = 0; i < objArray.length; i++) {
                    const obj = objArray[i];
                    if (obj.type == specificType) return true
                }
                return false
            }
            return true
        }

        getObjectsInSpace(xyArray) {
            let foundObjects = []
            for (let i = 0; i < this.boardObjectLocations.length; i++) {
                const boardObject = this.boardObjectLocations[i]
                if (boardObject.x == xyArray[0] && boardObject.y == xyArray[1]) {
                    foundObjects.push(boardObject)
                }
            }
            return foundObjects
        }

        countObjectsOfType(type) {
            let count = 0
            for (let i = 0; i < this.boardObjectLocations.length; i++) {
                const boardObject = this.boardObjectLocations[i]
                if (boardObject.type == type) {
                    count++
                }
            }
            return count
        }

        isPlayerInSpace(gamePlayers, newPos) {
            for (let i = 0; i < gamePlayers.length; i++) {
                const gp = gamePlayers[i]
                if (gp.positionX == newPos[0] && gp.positionY == newPos[1]) {
                    return true
                }
            }
            return false
        }

        async startGame() {

            if (this.status != 'new') {
                throw new Error("Game isn't new, and can't be started")
            }

            const guild = await this.sequelize.models.Guild.findByPk(this.GuildId)
            if (!guild) {
                throw new Error("Invalid teamId")
            }

            //position the players
            const gamePlayers = await this.getGamePlayers()
            const userRequestedBoardSize = guild.boardSize

            if (userRequestedBoardSize ** 2 < gamePlayers.length) { // if the board is too small, auto-size it
                const autoBoardSize = this.sequelize.models.Game.calculateBoardSize(gamePlayers.length, 0.1)
                this.boardHeight = autoBoardSize
                this.boardWidth = autoBoardSize
            } else {
                this.boardHeight = userRequestedBoardSize
                this.boardWidth = userRequestedBoardSize
            }
            this.minutesPerActionDistro = guild.actionTimerMinutes

            for (let index = 0; index < gamePlayers.length; index++) {
                let startingPos = this.findOpenPositionAroundPerimeter(gamePlayers)
                gamePlayers[index].positionX = startingPos[0]
                gamePlayers[index].positionY = startingPos[1]
                await gamePlayers[index].save()
            }

            this.addObject({
                type: 'goal',
                x: Math.floor(this.boardWidth / 2),
                y: Math.floor(this.boardHeight / 2)
            })

            await this.sprinklePickups(gamePlayers)

            //set the next AP distro time, change the game status to active
            const thisMoment = new Date()
            const nextTick = new Date(+new Date(thisMoment) + this.minutesPerActionDistro * 60 * 1000)
            this.status = 'active'
            this.startTime = thisMoment
            this.nextTickTime = nextTick

            await this.save()

            this.notify("## 🎲 **Game on!** 🎮 The latest [Infight.io game](" + this.getUrl() + ") has started! Band together to 👑 conquer others! Be the last.")

        }

        findOpenPositionAroundPerimeter(gamePlayers) {
            const perimeterPositions = []

            // Top and bottom rows
            for (let x = 0; x < this.boardWidth; x++) {
                perimeterPositions.push([x, 0]) // Top row
                perimeterPositions.push([x, this.boardHeight - 1]) // Bottom row
            }

            // Left and right columns
            for (let y = 1; y < this.boardHeight - 1; y++) {
                perimeterPositions.push([0, y]) // Left column
                perimeterPositions.push([this.boardWidth - 1, y]) // Right column
            }

            let startingPos
            do {
                startingPos = perimeterPositions[Math.floor(Math.random() * perimeterPositions.length)]
            } while (this.isPlayerInSpace(gamePlayers, startingPos) || this.isObjectInSpace(startingPos))
            return startingPos
        }

        getUrl() {
            return process.env.UI_BASE_URL + '/games/' + this.GuildId + '/' + this.id
        }
        notify(msg) {
            this.sequelize.models.Game.notifier.notify(this, msg)
        }
        async doTick() {

            if (this.status != 'active') {
                throw new Error("Game is not active")
            }

            const guild = await this.sequelize.models.Guild.findByPk(this.GuildId)
            if (!guild) {
                throw new Error("Invalid teamId")
            }

            try {
                const thisMoment = new Date()
                const nextTick = new Date(+new Date(thisMoment) + this.minutesPerActionDistro * 60 * 1000)
                this.nextTickTime = nextTick
                const gameSaved = await this.save()

                let players = await this.getGamePlayers()

                const playersOnGoals = this.findPlayersOnGoals(players)
                for (let i = 0; i < playersOnGoals.length; i++) {
                    const goalPlayer = playersOnGoals[i];
                    if (goalPlayer.status == 'alive') {
                        const gpScore = Stats.increment(goalPlayer, Stats.GamePlayerStats.gamePoint)
                        this.notify(`<@${goalPlayer.PlayerId}> 🏆 held a goal and scored a point! They have *${gpScore}/5* points to win! 🏆`);
                        await goalPlayer.save()
                        if (gpScore >= 5) { // game is won at five points... TODO: make configurable, handle ties
                            await this.endGameAndBeginAnew('won', [goalPlayer], guild);
                        }
                    }
                }

                await this.giveAllLivingPlayersAP(2)
                await this.respawnDeadPlayers(players)

                await this.sprinklePickups(players)

                this.expandFires()

                //burn people standing in fire
                let playersKilledByEnvironment = []
                players = await this.getGamePlayers();
                const livingPlayers = this.constructor.getLivingPlayers(players)
                const countAliveBeforeEnvironmentalDeaths = livingPlayers.length;
                let numBurnedByFire = 0
                for (let i = 0; i < this.boardObjectLocations.length; i++) {
                    let obj = this.boardObjectLocations[i];
                    if (obj.type == 'fire') {
                        for (let j = 0; j < livingPlayers.length; j++) {
                            let player = livingPlayers[j];
                            if (player.positionX == obj.x && player.positionY == obj.y) {
                                player.health -= 1
                                numBurnedByFire++
                                if (player.health == 0) {
                                    player.status = 'dead'
                                    player.deathTime = new Date()
                                    playersKilledByEnvironment.push(player)
                                    this.notify("🔥 <@" + player.PlayerId + "> was cooked dead! 🔥")
                                } else {
                                    this.notify("🔥 <@" + player.PlayerId + "> was burned for 1 HP by a fire! 🔥")
                                }
                                await player.save()
                            }
                        }
                    }
                }


                if (this.suddenDeathRound == 0) {
                    this.notify("⚡ Infight distributed AP! [Make a move](" + this.getUrl() + ") and watch your back!")
                }

                if (this.suddenDeathRound > 0 && false) { // disabled for now
                    const edgeDistance = this.suddenDeathRound; // Define the distance from the edge you want to check

                    await this.giveAllLivingPlayersAP(2)
                    this.notify("🌪️ **The storm** is closing in! You draw an extra AP from its power! 🌪️")

                    const players = await this.getGamePlayers(); //get this again, so as not to process players killed by fire again
                    const livingPlayers = this.constructor.getLivingPlayers(players)
                    for (let i = 0; i < livingPlayers.length; i++) {
                        const player = livingPlayers[i];
                        const { positionX, positionY } = player;

                        if (
                            positionX + 1 <= edgeDistance || // Left edge
                            positionX >= this.boardWidth - (edgeDistance + 1) || // Right edge
                            positionY + 1 <= edgeDistance || // Top edge
                            positionY >= this.boardHeight - (edgeDistance + 1) // Bottom edge
                        ) {
                            console.log(`Player ${player.PlayerId} is within ${edgeDistance} units from the edge.`);
                            player.health -= 1;
                            Stats.increment(player, Stats.GamePlayerStats.zapped)

                            if (player.health === 0) {
                                player.status = 'dead';
                                player.deathTime = new Date();
                                playersKilledByEnvironment.push(player);
                                this.notify(`🌪️ **The storm** shocked and killed <@${player.PlayerId}>! They're out!`);
                            } else {
                                this.notify(`🌪️ **The storm** shocked <@${player.PlayerId}> for 1 HP! Run to the center!`);
                            }
                            await player.save();
                        }
                    }

                    //don't grow wider than half the width
                    if (this.suddenDeathRound < Math.ceil(this.boardHeight / 2)) {
                        this.suddenDeathRound += 1;
                    }
                }

                //all remaining players were killed by environment
                if (playersKilledByEnvironment.length == countAliveBeforeEnvironmentalDeaths) {
                    // mark all winPositions as 2
                    for (let i = 0; i < playersKilledByEnvironment.length; i++) {
                        const player = playersKilledByEnvironment[i];
                        player.winPosition = 2;
                        await player.save();
                    }

                    await this.endGameAndBeginAnew('tied', playersKilledByEnvironment, guild);
                    return;
                }

                // if some were killed by env., but not all, save the dead's winPositions
                if (playersKilledByEnvironment.length > 0 && playersKilledByEnvironment.length < countAliveBeforeEnvironmentalDeaths) {
                    const countRemaining = countAliveBeforeEnvironmentalDeaths - playersKilledByEnvironment.length;
                    for (let i = 0; i < playersKilledByEnvironment.length; i++) {
                        const player = playersKilledByEnvironment[i];
                        player.winPosition = countRemaining + 1;
                        await player.save();
                    }
                }

                // if only one player remains, they win
                if (playersKilledByEnvironment.length > 0 && countAliveBeforeEnvironmentalDeaths - playersKilledByEnvironment.length == 1) {
                    let lastBro = this.constructor.getLivingPlayers(livingPlayers)[0];
                    lastBro.winPosition = 1;
                    await lastBro.save();
                    await this.endGameAndBeginAnew('won', [lastBro], guild);
                    return;
                }

                await this.save();

            } catch (error) {
                console.log("game.doTick error", error)
            }

        }

        async sprinklePickups(players) {

            const numHearts = this.countObjectsOfType('heart')
            const desiredHearts = Math.floor(this.boardWidth * 0.9)
            if (numHearts < desiredHearts) {
                for (let i = 0; i < desiredHearts - numHearts; i++) {
                    await this.addHeart(players)
                }
            }

            const numPowers = this.countObjectsOfType('power')
            const desiredPowers = Math.floor(this.boardWidth * 0.9)
            if (numPowers < desiredPowers) {
                for (let i = 0; i < desiredPowers - numPowers; i++) {
                    await this.addPower(players)
                }
            }

        }

        async respawnDeadPlayers(players) {
            const deadPlayers = players.filter(player => player.status === 'dead')
            for (const player of deadPlayers) {
                const respawnPos = this.findOpenPositionAroundPerimeter(players)
                player.positionX = respawnPos[0]
                player.positionY = respawnPos[1]
                player.health = 3
                player.actions += 2
                player.status = 'alive'
                player.deathTime = null
                player.winPosition = null
                await player.save()
            }
            if (deadPlayers.length > 0) {
                const respawnedPlayerIds = deadPlayers.map(player => `<@${player.PlayerId}>`).join(', ')
                this.notify(`${respawnedPlayerIds} are back in the game!`)
            }
        }

        findPlayersOnGoals(players) {
            const goalObjects = this.boardObjectLocations.filter(obj => obj.type === 'goal')
            const playersOnGoals = []

            for (const goal of goalObjects) {
                for (const player of players) {
                    if (player.positionX === goal.x && player.positionY === goal.y) {
                        playersOnGoals.push(player)
                    }
                }
            }
            return playersOnGoals
        }
        isSpotOnBoard(x, y) {
            return x >= 0 && x < this.boardWidth && y >= 0 && y < this.boardHeight
        }
        expandFires() {
            let firesExpanded = 0
            const newFireChance = 0.2
            try {
                for (let i = 0; i < this.boardObjectLocations.length; i++) {
                    let obj = this.boardObjectLocations[i]
                    if (obj.type == 'fire') {
                        if (Math.random() < newFireChance) {

                            const randomDirection = this.getRandomDirection()
                            const newFireX = obj.x + randomDirection[0]
                            const newFireY = obj.y + randomDirection[1]
                            if (this.isSpotOnBoard(newFireX, newFireY) && !this.isObjectInSpace([newFireX, newFireY], 'fire')) {
                                firesExpanded++
                                this.addObject({
                                    type: 'fire',
                                    x: newFireX,
                                    y: newFireY
                                })
                            }
                        }
                    }
                }
                if (firesExpanded > 0) {
                    this.notify(`🔥 ** ${firesExpanded} Fires** spread! 🔥`)
                }
            } catch (error) {
                console.log("fire xpansion err", error)
            }
        }

        getRandomDirection() {
            const directions = [
                [-1, 0], [1, 0], [0, -1], [0, 1], // cardinal directions
                [-1, -1], [1, 1], [-1, 1], [1, -1] // diagonal directions
            ]
            const randomDirection = directions[Math.floor(Math.random() * directions.length)]
            return randomDirection
        }

        async giveAllLivingPlayersAP(ap) {
            await this.sequelize.query('UPDATE "GamePlayers" SET actions = actions + ? WHERE "GameId" = ? AND status = ?', {
                replacements: [ap, this.id, 'alive']
            })
        }

        static async createNewGame(guildId) {
            try {

                // check if there's an active game
                const guild = await this.sequelize.models.Guild.findByPk(guildId)
                if (guild === null) {
                    throw new Error("Invalid guild")
                }

                if (guild.currentGameId) {
                    throw new Error("Already a game in progress")
                }

                // create the game
                const game = this.build({
                    minutesPerActionDistro: guild.actionTimerMinutes,
                    boardWidth: guild.boardSize,
                    boardHeight: guild.boardSize,
                    GuildId: guild.id,
                    minimumPlayerCount: guild.minimumPlayerCount
                })

                await game.save()
                console.log('created game ' + game.id, game)

                //set the current game on the Guild
                guild.currentGameId = game.id
                await guild.save()

                //find all opted-in players and add them to the game
                const optedInGuildMembers = await this.sequelize.models.PlayerGuild.findAll({
                    where: {
                        GuildId: guild.id,
                        isOptedInToPlay: true
                    }
                })

                for (let i = 0; i < optedInGuildMembers.length; i++) {
                    const gm = optedInGuildMembers[i];
                    await game.addPlayer(gm.PlayerId)
                }


                // send some hype abouut the muster period)
                game.notify("Alright! 🃏 [New Infight Game](" + game.getUrl() + ") created with " + optedInGuildMembers.length + " players!")

                //choose about starting soon, or waiting for more to join
                if (optedInGuildMembers.length < game.minimumPlayerCount) {
                    game.notify("To start [the new game](" + game.getUrl() + "), there need to be at least " + game.minimumPlayerCount + " players. Ask a friend to `/infight-join`!")
                } else {
                    game.checkShouldStartGame()
                }


                return game

            } catch (error) {
                console.log('CreateNewGame error', error)
                throw error
            }
        }

        async cancelAndStartNewGame() {
            this.notify("⚠️ Game " + this.id + " cancelled by an admin. Sorry about that! New game coming up!")
            const guildId = this.GuildId
            this.status = 'cancelled'
            await this.save();

            const GameRef = this.sequelize.models.Game
            const guild = await this.sequelize.models.Guild.findByPk(guildId)
            if (guild != null) {
                guild.currentGameId = null
                const guildSave = await guild.save()
            }

            await GameRef.createNewGame(guild.id)
        }

        async doMove(player, action, targetX, targetY) {


            if (this.status != 'active') {
                throw new Error("Game is not active")
            }


            // get current GamePlayer
            var gp = null
            for (let i = 0; i < this.GamePlayers.length; i++) {
                const foundGp = this.GamePlayers[i];
                if (foundGp.PlayerId == player.id) {
                    gp = foundGp
                }
            }
            if (!gp) {
                throw new Error("You aren't in this game")
            }

            if (gp.actions < 1 && !['giveHP', 'juryVote', 'startFire'].includes(action)) {
                throw new Error("You don't have enough AP")
            }

            if (gp.status != 'alive' && !['juryVote', 'startFire'].includes(action)) {
                throw new Error("You're not alive.")
            }

            const guild = await this.sequelize.models.Guild.findByPk(this.GuildId)
            if (!guild) {
                throw new Error("You aren't in this game")
            }


            if (Number.isInteger(targetX) && Number.isInteger(targetY)) {
                if (targetX < 0 || targetX >= this.boardWidth || targetY < 0 || targetY > this.boardHeight - 1) {
                    throw new Error("Action is off the board")
                }
            }

            const move = this.sequelize.models.Move.build({
                GameId: this.id,
                action: action,
                targetPositionX: targetX,
                targetPositionY: targetY,
                actingGamePlayerId: gp.id
            })

            //for aimed actions, check range and target values
            const currentX = gp.positionX
            const currentY = gp.positionY
            if (['move', 'shoot', 'giveAP', 'giveHP', 'juryVote', 'startFire', 'shove'].includes(action)) {
                if (isNaN(Number(targetX)) || isNaN(Number(targetY))) {
                    throw new Error("Target is not numeric")
                }

                let rangeToCheck = 1
                if (!['move', 'shove'].includes(action)) rangeToCheck = gp.range
                if (!['juryVote', 'startFire'].includes(action)) {
                    if (targetX < currentX - rangeToCheck || targetX > currentX + rangeToCheck || targetY < currentY - rangeToCheck || targetY > currentY + rangeToCheck) {
                        throw new Error("That is out of range")
                    }
                }
            }

            //find any player in the target space
            let targetGamePlayer = null;
            for (let i = 0; i < this.GamePlayers.length; i++) {
                const somePlayer = this.GamePlayers[i];
                if (somePlayer.positionX == targetX && somePlayer.positionY == targetY) {
                    targetGamePlayer = somePlayer
                }
            }


            if (action == 'juryVote') {
                if (gp.health > 0) {
                    throw new Error("You need to be dead to vote")
                }

                if (gp.juryVotesToSpend == 0) {
                    throw new Error("You've already voted")
                }

                if (targetGamePlayer.status != 'alive') {
                    throw new Error("That fool's dead")
                }

                gp.juryVotesToSpend = 0
                targetGamePlayer.actions += 1
                Stats.increment(gp, Stats.GamePlayerStats.gaveTreat)
                Stats.increment(targetGamePlayer, Stats.GamePlayerStats.wasTreated)

                await gp.save()
                await targetGamePlayer.save()
                await move.save()

                this.notify("<@" + gp.PlayerId + "> 🍬 **treated** <@" + targetGamePlayer.PlayerId + "> to an extra AP! 🍬")

                return "Treated!"
            }

            if (action == 'startFire') {
                if (gp.health > 0) {
                    throw new Error("You need to be dead to start fires")
                }

                if (gp.juryVotesToSpend == 0) {
                    throw new Error("You're out of JP")
                }

                if (targetGamePlayer != null) {
                    throw new Error("Sorry, you can't light your friends on fire")
                }

                gp.juryVotesToSpend = 0

                Stats.increment(gp, Stats.GamePlayerStats.startFire)

                this.addObject({
                    type: 'fire',
                    x: Number(targetX),
                    y: Number(targetY)
                })

                await this.save()
                await gp.save()
                await move.save()

                this.notify("<@" + gp.PlayerId + ">'s ghost 🔥 **lit a fire**! 🔥")

                return "Ignited!"
            }

            if (action == 'upgrade') {
                if (gp.actions < 3) {
                    throw new Error("You don't have enough AP")
                }
                gp.range += 1
                gp.actions -= 3
                Stats.increment(gp, Stats.GamePlayerStats.upgradedRange)

                await gp.save()
                await move.save()

                this.notify("<@" + gp.PlayerId + "> 🔧 **upgraded** their range to " + gp.range + "!")

                return "Upgraded!"
            }

            if (action == 'heal') {
                if (gp.actions < 3) {
                    throw new Error("You don't have enough AP")
                }
                gp.health += 1
                gp.actions -= 3
                Stats.increment(gp, Stats.GamePlayerStats.healed)

                await gp.save()
                await move.save()

                this.notify("<@" + gp.PlayerId + "> ❤️ **healed** to **" + gp.health + "**!")

                return "Upgraded!"
            }

            if (action == 'shove') {
                if (gp.actions < 1) {
                    throw new Error("You don't have enough AP")
                }

                //target destination check?
                const deltaX = Number(targetX) - gp.positionX;
                const deltaY = Number(targetY) - gp.positionY;
                const newX = Number(targetX) + deltaX;
                const newY = Number(targetY) + deltaY;

                if (newX < 0 || newX > this.boardWidth - 1 || newY < 0 || newY > this.boardHeight - 1) {
                    throw new Error("Shove target is off the board");
                }

                let allPlayers = await this.getGamePlayers()
                if (this.isPlayerInSpace(allPlayers, [newX, newY])) {
                    throw new Error("Shove target space is occupied by some nerd");
                }

                let wasOnGoal = this.isObjectInSpace([targetGamePlayer.positionX, targetGamePlayer.positionY], 'goal')
                targetGamePlayer.positionX = newX;
                targetGamePlayer.positionY = newY;

                const preShovedHp = targetGamePlayer.health;
                const preShovedAp = targetGamePlayer.actions;
                this.doObjectInteractionsForPlayer(newX, newY, targetGamePlayer)

                if (preShovedHp > targetGamePlayer.health) {
                    if (targetGamePlayer.health < 1) {
                        this.markPlayerDead(targetGamePlayer)
                        this.notify("<@" + gp.PlayerId + "> **shoved** <@" + targetGamePlayer.PlayerId + "> to their firey death! 🔥 ☠️")
                    } else {
                        this.notify("<@" + gp.PlayerId + "> **shoved** <@" + targetGamePlayer.PlayerId + "> into a fire! 🔥")
                    }
                }

                if (preShovedHp < targetGamePlayer.health) {
                    this.notify("<@" + gp.PlayerId + "> **shoved** <@" + targetGamePlayer.PlayerId + "> into a heart! 💝")
                }
                if (preShovedAp < targetGamePlayer.actions) {
                    this.notify("<@" + gp.PlayerId + "> **shoved** <@" + targetGamePlayer.PlayerId + "> into some AP! ⚡")
                }

                if (preShovedHp == targetGamePlayer.health && preShovedAp == targetGamePlayer.actions) {
                    this.notify("<@" + gp.PlayerId + "> **shoved** <@" + targetGamePlayer.PlayerId + "> out of their way!")
                }

                if (this.isObjectInSpace([targetGamePlayer.positionX, targetGamePlayer.positionY], 'goal')) {
                    this.notify(`🚨 <@${targetGamePlayer.PlayerId}> was *SHOVED* onto a goal spot! 🏁 How nice! 🎁`);
                }
                if (wasOnGoal) {
                    this.notify(`🚨 <@${targetGamePlayer.PlayerId}> was *SHOVED* off of a goal spot! 🏁 Drama! 🎭`);
                }

                await targetGamePlayer.save();

                gp.actions -= 1
                Stats.increment(gp, Stats.GamePlayerStats.shoved)

                await gp.save()
                await move.save()



                return "Upgraded!"
            }

            if (action == 'move') {
                if (targetGamePlayer != null) {
                    throw new Error("A player is already in that space")
                }

                const preMovedHp = gp.health;
                const preMovedAp = gp.actions;
                this.doObjectInteractionsForPlayer(targetX, targetY, gp)

                let moveConsequence = ''
                if (gp.health < 1) {
                    this.markPlayerDead(gp)
                    this.notify("<@" + gp.PlayerId + "> **threw themselves in a fire!** 🔥 ☠️")
                } else {
                    if (preMovedHp > gp.health) {
                        moveConsequence += " through fire 🔥"
                    }
                    if (preMovedHp < gp.health) {
                        moveConsequence += " and picked up a heart 💝"
                    }
                    if (preMovedAp < gp.actions) {
                        moveConsequence += " and picked up a some AP ⚡"
                    }
                }

                const directionDescription = this.sequelize.models.Move.describeMoveDirection([gp.positionX, gp.positionY], [targetX, targetY])
                const movementVerb = this.sequelize.models.Move.getRandomMovementDescriptionWithEmoji()

                let wasOnGoal = this.isObjectInSpace([gp.positionX, gp.positionY], 'goal')

                gp.positionX = targetX
                gp.positionY = targetY
                gp.actions -= 1

                Stats.increment(gp, Stats.GamePlayerStats.walked)

                await gp.save()
                await move.save()

                if (gp.health > 0) {
                    this.notify(`<@${gp.PlayerId}> ${movementVerb} ${directionDescription}${moveConsequence}!`)
                }

                if (this.isObjectInSpace([targetX, targetY], 'goal')) {
                    this.notify(`🚨 <@${gp.PlayerId}> is on a goal spot! 🏁 Unseat them or they'll score!`);
                }
                if (wasOnGoal) {
                    this.notify(`🚨 <@${gp.PlayerId}> abandoned a goal spot! 🏁 It's your chance! 🏃`);
                }

                return "Moved!"
            }

            if (action == 'giveAP') {
                if (targetGamePlayer == null) {
                    throw new Error("There's no player at that target to gift")
                }
                if (targetGamePlayer.status != 'alive') {
                    throw new Error("They dead!")
                }

                targetGamePlayer.actions += 1
                gp.actions -= 1
                Stats.increment(gp, Stats.GamePlayerStats.gaveAp)
                Stats.increment(targetGamePlayer, Stats.GamePlayerStats.wasGiftedAp)

                await gp.save()
                await targetGamePlayer.save()
                move.targetGamePlayerId = targetGamePlayer.id
                await move.save()

                this.notify("<@" + gp.PlayerId + "> (" + gp.actions + " AP) 🤝 gave an AP to <@" + targetGamePlayer.PlayerId + "> (" + targetGamePlayer.actions + " AP)!")

                return "Gave AP!"
            }

            if (action == 'giveHP') {
                if (targetGamePlayer == null) {
                    throw new Error("There's no player at that target to gift")
                }

                if (gp.health < 2) {
                    throw new Error("You don't have enough health to give")
                }

                targetGamePlayer.health += 1
                Stats.increment(targetGamePlayer, Stats.GamePlayerStats.gotHp)
                if (targetGamePlayer.health == 1) { // do a resurrection!
                    targetGamePlayer.status = 'alive'
                    targetGamePlayer.winPosition = null
                    targetGamePlayer.deathTime = null

                    Stats.increment(gp, Stats.GamePlayerStats.resurrector)
                    Stats.increment(targetGamePlayer, Stats.GamePlayerStats.resurrectee)

                    await targetGamePlayer.save()

                    //reshuffle the winPositions in the GamePlayers
                    let allPlayers = await this.sequelize.models.GamePlayer.findAll({
                        where: {
                            GameId: this.id
                        },
                        order: [
                            ['deathTime', 'ASC', 'NULLS LAST']
                        ]
                    })

                    for (let i = 0; i < allPlayers.length; i++) {
                        const maybeDeadPlayer = allPlayers[i];
                        if (maybeDeadPlayer.health == 0) {
                            maybeDeadPlayer.winPosition = allPlayers.length - i
                            maybeDeadPlayer.save() //not awaited, might race condition 
                        }
                    }

                }
                gp.health -= 1
                Stats.increment(gp, Stats.GamePlayerStats.gaveHp)

                await gp.save()
                await targetGamePlayer.save()
                move.targetGamePlayerId = targetGamePlayer.id
                await move.save()

                if (targetGamePlayer.health == 1) {
                    this.notify("<@" + gp.PlayerId + "> 😇 brought <@" + targetGamePlayer.PlayerId + "> back from the dead!")

                } else {
                    this.notify("<@" + gp.PlayerId + "> (" + gp.health + " HP) 💌 gave an HP to <@" + targetGamePlayer.PlayerId + "> (" + targetGamePlayer.health + " HP)!")
                }

                return "Gave HP!"
            }

            if (action == 'shoot') {

                if (this.isObjectInSpace([targetX, targetY], 'fire')) {
                    this.removeObjectInSpace([targetX, targetY], 'fire')
                    this.notify("💦 <@" + gp.PlayerId + "> squirted out a fire! 💦")
                    if (!targetGamePlayer) {
                        gp.actions -= 1
                        await gp.save()
                        return "Squirt!"
                    }
                }

                let gamePlayers = await this.getGamePlayers()
                const lootGoblin = this.getObjectsInSpace([targetX, targetY]).find(obj => obj.type === 'lootGoblin');
                if (lootGoblin) {
                    lootGoblin.health -= 1;

                    let flavas = ['heart', 'power']
                    let typeToDrop = flavas[Math.floor(Math.random() * flavas.length)];
                    if (typeToDrop == 'heart') {
                        gp.health += 1
                    } else {
                        gp.actions += 1
                    }

                    if (lootGoblin.health <= 0) {

                        let heartCount = lootGoblin.stolenLoot.hearts + 3
                        let powerCount = lootGoblin.stolenLoot.powers + 3 //ditch?

                        for (let i = 0; i < 9; i++) { //all around

                            const lootyFlav = flavas[Math.floor(Math.random() * flavas.length)];

                            let seekCount = 0
                            let foundLootSpot = false
                            while (!foundLootSpot) {
                                seekCount++
                                if (seekCount > 100) {
                                    break
                                }

                                const randomDirection = this.getRandomDirection()
                                const lootX = lootGoblin.x + randomDirection[0]
                                const lootY = lootGoblin.y + randomDirection[1]

                                if (this.isSpotOnBoard(lootX, lootY)
                                    && !this.isPlayerInSpace(gamePlayers, [lootX, lootY])
                                    && !this.isObjectInSpace([lootX, lootY])) {
                                    foundLootSpot = true
                                    this.boardObjectLocations.push({
                                        type: lootyFlav,
                                        x: lootX,
                                        y: lootY
                                    })
                                }
                            }
                        }


                        this.removeObjectInSpace([targetX, targetY], 'lootGoblin');
                        this.boardObjectLocations.push({ //replace goblin with power
                            type: 'power',
                            x: Number(targetX),
                            y: Number(targetY)
                        })

                        this.notify("💀 <@" + gp.PlayerId + "> **killed** the Loot Goblin, pickups exploded everywhere! 💀");
                    } else {
                        this.notify("💥 <@" + gp.PlayerId + "> **shot** the Loot Goblin and gained a " + typeToDrop + "! It has " + lootGoblin.health + " health left. 💥");
                        //drop either one heart or one power
                    }
                    this.changed('boardObjectLocations', true); // deep change operations in a json field aren't automatically detected by sequelize
                    await this.save();
                    return "Shot Loot Goblin!";
                }

                if (!targetGamePlayer) {
                    throw new Error("No player at that position")
                }

                if (targetGamePlayer.health <= 0) {
                    throw new Error("They're dead, Jim!")
                }

                Stats.increment(gp, Stats.GamePlayerStats.shotSomeone)
                Stats.increment(targetGamePlayer, Stats.GamePlayerStats.wasShot)

                targetGamePlayer.health -= 1
                if (targetGamePlayer.health <= 0) {

                    Stats.increment(gp, Stats.GamePlayerStats.killedSomeone)
                    Stats.increment(targetGamePlayer, Stats.GamePlayerStats.wasKilled)

                    gp.actions += Math.floor(targetGamePlayer.actions / 2)  // give the killer an AP reward

                    this.markPlayerDead(targetGamePlayer)
                }

                //check if game is over
                let countAlive = this.constructor.getLivingPlayers(this.GamePlayers).length
                targetGamePlayer.winPosition = countAlive + 1
                await targetGamePlayer.save()

                gp.actions -= 1
                await gp.save()

                move.targetGamePlayerId = targetGamePlayer.id
                await move.save()

                let shotMsg = "<@" + gp.PlayerId + "> **💥shot💥** <@" + targetGamePlayer.PlayerId + ">, reducing their health to **" + targetGamePlayer.health + "**! 🩸"
                if (targetGamePlayer.health == 0) {
                    shotMsg = "### <@" + gp.PlayerId + "> **☠️ ELIMINATED ☠️** <@" + targetGamePlayer.PlayerId + ">  and got an AP back!"
                }
                this.notify(shotMsg)

                //start sudden death
                // if (countAlive == 2 && this.suddenDeathRound == 0) {
                //     this.suddenDeathRound = 1
                //     await this.save()
                //     this.notify("🚨 **Sudden Death!** Only two players remain! The storm approaches! 🌪️")
                // }

                // if (countAlive == 1) {
                //     gp.winPosition = 1
                //     await gp.save()
                //     await this.endGameAndBeginAnew('won', [gp], guild)
                // }

                return "Shot!"
            }

            throw new Error("Action Not implemented", action)
        }

        markPlayerDead(targetGamePlayer) {
            targetGamePlayer.status = 'dead'
            targetGamePlayer.actions = Math.floor(targetGamePlayer.actions / 2)
            targetGamePlayer.juryVotesToSpend = 1
            targetGamePlayer.deathTime = new Date()
        }

        doObjectInteractionsForPlayer(targetX, targetY, gp) {
            let objectsTheySteppedOn = this.getObjectsInSpace([targetX, targetY])
            for (let i = 0; i < objectsTheySteppedOn.length; i++) {
                const obj = objectsTheySteppedOn[i];
                if (obj.type == 'heart') {
                    gp.health += 1
                    this.removeObjectInSpace([targetX, targetY], 'heart')
                }
                if (obj.type == 'power') {
                    gp.actions += Math.floor(Math.random() * 3) + 1
                    this.removeObjectInSpace([targetX, targetY], 'power')
                }
                if (obj.type == 'fire') {
                    gp.health -= 1
                }
            }
        }

        async endGameAndBeginAnew(winType, winningPlayerArray, guild) {
            this.status = winType

            if (winningPlayerArray.length == 1) {
                this.winningPlayerId = winningPlayerArray[0].id
                this.notify("# 🎉 👑 <@" + winningPlayerArray[0].PlayerId + "> **_WON THE INFIGHT!!_** 🏁 🎉")
            }

            if (winningPlayerArray.length > 1) {
                this.notify("# 🥈 👔 <@" + winningPlayerArray.map(gp => gp.PlayerId).join('> and <@') + "> **_TIED FOR 2nd!!_** 🏁 🤝")
            }

            await this.save()
            await this.calcWinPositions()
            await this.sendAfterActionReport()

            guild.currentGameId = null
            await guild.save()

            await this.sequelize.models.Game.createNewGame(this.GuildId)
        }

        static getLivingPlayers(gamePlayers) {
            let livingPlayers = []
            for (let i = 0; i < gamePlayers.length; i++) {
                const somePlayer = gamePlayers[i]
                if (somePlayer.status == 'alive') {
                    livingPlayers.push(somePlayer)
                }
            }
            return livingPlayers
        }

        addObject(obj) {
            if (!Array.isArray(this.boardObjectLocations)) {
                this.boardObjectLocations = []
            }
            this.boardObjectLocations.push(obj)
            this.changed('boardObjectLocations', true); // deep change operations in a json field aren't automatically detected by sequelize
        }

        async findFreeSpaceAndAddObj(gamePlayers, obj) {
            try {
                const freeSpace = await this.#findClearSpace(gamePlayers)
                obj.x = freeSpace[0]
                obj.y = freeSpace[1]

                this.addObject(obj)
                //console.log('added a heart at', freeSpace)
                await this.save()
                //console.log('saveResult', saveResult)
            } catch (error) {
                console.log(`couldnt add obj: ${obj.type}`, error)
            }
        }

        async addHeart(gamePlayers) {
            this.findFreeSpaceAndAddObj(gamePlayers, {
                type: 'heart'
            })
        }

        async addPower(gamePlayers) {
            this.findFreeSpaceAndAddObj(gamePlayers, {
                type: 'power'
            })
        }

        static async startGamesNeedingToStart() {
            let gamesNeedingStarts = await this.findAll({
                where: {
                    startTime: {
                        [Op.lt]: new Date(),
                    },
                    status: 'new'
                },
            })

            for (let i = 0; i < gamesNeedingStarts.length; i++) {
                const game = gamesNeedingStarts[i];
                game.startGame()
            }
        }

        static async tickGamesNeedingTick() {
            let gamesNeedingTicks = await this.findAll({
                where: {
                    nextTickTime: {
                        [Op.lt]: new Date(),
                    },
                    status: 'active'
                },
            })

            for (let i = 0; i < gamesNeedingTicks.length; i++) {
                const game = gamesNeedingTicks[i];
                game.doTick()
            }
        }

        static async sprinkleEnemies() {
            let activeGames = await this.findAll({
                where: {
                    status: 'active'
                },
            })

            for (let i = 0; i < activeGames.length; i++) {
                const game = activeGames[i];
                if (Math.random() < 0.03) {
                    await game.addLootGoblin();
                }
            }
        }

        async addLootGoblin() {
            const gamePlayers = await this.getGamePlayers()
            let emptySpace = await this.#findClearSpace(gamePlayers)
            if (emptySpace === null) {
                return
            }

            let enemy = {
                type: 'lootGoblin',
                x: emptySpace[0],
                y: emptySpace[1],
                health: 4,
                turnsLeft: 10,
                stolenLoot: {
                    hearts: 0,
                    powers: 0
                }
            }
            this.addObject(enemy)
            this.save()
            this.notify("🦹‍♂️ **A Loot Goblin** has appeared! 🦹‍♂️")

            const secsPerGoblinMove = 30
            const goblinNewSpotChecks = 5
            let intyGob = setInterval(async () => {

                //find the goblin, to see if it's been shot or dead or whatever
                let freshGame = await this.constructor.findByPk(this.id)

                const freshGoblin = freshGame.boardObjectLocations.filter(obj => obj.type === 'lootGoblin')[0]
                if (!freshGoblin || freshGoblin == null) {
                    clearInterval(intyGob);
                    return
                }
                const innerGamePlayers = await freshGame.getGamePlayers()

                let checkCount = 0
                let foundNewGoblinSpace = false
                while (!foundNewGoblinSpace) {
                    checkCount++
                    if (checkCount > goblinNewSpotChecks) {
                        break //feels boxed in
                    }
                    const randomDirection = this.getRandomDirection()
                    const newGobboX = freshGoblin.x + randomDirection[0]
                    const newGobboY = freshGoblin.y + randomDirection[1]
                    if (this.isSpotOnBoard(newGobboX, newGobboY) && !freshGame.isPlayerInSpace(innerGamePlayers, [newGobboX, newGobboY])) {
                        freshGoblin.x = newGobboX
                        freshGoblin.y = newGobboY
                        foundNewGoblinSpace = true
                    }
                }

                let lootGoblinMoveText = "🦹‍♂️ **Loot Goblin** scurried! 🦹‍♂️"

                const adjacentPlayers = innerGamePlayers.filter(player => {
                    const dx = Math.abs(player.positionX - freshGoblin.x);
                    const dy = Math.abs(player.positionY - freshGoblin.y);
                    return (dx <= 1 && dy <= 1) && (dx + dy !== 0); // Ensure it's adjacent and not the same spot
                });

                if (adjacentPlayers.length > 0) {
                    const playerIds = adjacentPlayers.map(player => `<@${player.PlayerId}>`).join(' and ');

                    const verbs = [
                        'sneaked past 🕵️‍♂️',
                        'darted around 🏃‍♂️',
                        'slipped by 🕶️',
                        'slapped ✋',
                        'dodged 🌀',
                        'evaded 🏃‍♀️',
                        'juked 🏃‍♂️',
                        'kissed 💋',
                        'nudged 🤏',
                        'pinched 🤏',
                        'brushed by 💨',
                        'slid past 🛷',
                        'farted on 🤢',
                        'chucked dookie 💩 on ',
                        'sprinted past 🏃‍♂️',
                        'teleported by 🌀',
                        'zoomed past 🚀',
                        'sneaked by 🕵️‍♀️',
                        'tiptoed around 👣',
                        'whizzed by 💨',
                        'slinked past 🐍',
                        'dashed past 🏃‍♀️',
                        'glided by 🛷',
                        'whisked past 🌬️'
                    ]
                    let verb = verbs[Math.floor(Math.random() * verbs.length)];
                    lootGoblinMoveText = `🦹‍♂️ **Loot Goblin** *${verb}* ${playerIds}! 🦹‍♂️`
                }

                let stoleText = '';
                const objectsAtGoblin = freshGame.getObjectsInSpace([freshGoblin.x, freshGoblin.y]);
                for (const obj of objectsAtGoblin) {
                    if (obj.type === 'heart' || obj.type === 'power') {
                        freshGame.removeObjectInSpace([freshGoblin.x, freshGoblin.y], obj.type);
                        let itemEmoji = obj.type === 'heart' ? '❤️' : '⚡';
                        stoleText = ` and stole a ${obj.type} ${itemEmoji}! `;

                        if (obj.type === 'heart') {
                            freshGoblin.stolenLoot.hearts += 1;
                        } else if (obj.type === 'power') {
                            freshGoblin.stolenLoot.powers += 1;
                        }
                    }
                }

                freshGoblin.turnsLeft -= 1

                if (freshGoblin.turnsLeft < 1) {
                    freshGame.removeObjectInSpace([freshGoblin.x, freshGoblin.y], 'lootGoblin')
                    freshGame.notify("🦹‍♂️ **Loot Goblin** has fled! 🦹‍♂️")
                    clearInterval(intyGob);
                    return
                }
                freshGame.changed('boardObjectLocations', true); // deep change operations in a json field aren't automatically detected by sequelize
                freshGame.save()

                if (!foundNewGoblinSpace) {
                    lootGoblinMoveText = "🦹‍♂️ **Loot Goblin** feels cornered! 🦹‍♂️"
                }
                freshGame.notify(lootGoblinMoveText + stoleText)

            }, 1000 * secsPerGoblinMove);
        }

        static calculateBoardSize(playerCount, desiredDensity = 0.2) {
            if (playerCount <= 0 || desiredDensity <= 0) {
                throw new Error("calculateBoardSize Player count and density must be greater than zero.");
            }

            // Calculate the required board area for the given density
            const requiredArea = playerCount / desiredDensity;

            // Determine the side length of the square board
            const boardSize = Math.ceil(Math.sqrt(requiredArea));
            return boardSize;
        }

        async calcWinPositions() {

            //after action report
            let allPlayers = await this.sequelize.models.GamePlayer.findAll({
                where: {
                    GameId: this.id
                },
                order: [
                    ['winPosition', 'ASC']
                ]
            })

            //order them like the front end scoreboard
            allPlayers.forEach(player => {
                if (player.stats.gamePoint === undefined) {
                    player.stats.gamePoint = 0;
                }
            });

            let sortedPlayers = allPlayers.sort((a, b) => {

                if (b.stats.gamePoint === a.stats.gamePoint) {
                    return b.stats.killedSomeone - a.stats.killedSomeone;
                }
                return b.stats.gamePoint - a.stats.gamePoint
            })
            for (let i = 0; i < sortedPlayers.length; i++) {
                const p = sortedPlayers[i];
                p.winPosition = i + 1
                await p.save()
            }

            return sortedPlayers
        }

        async sendAfterActionReport() {


            let allPlayers = await this.sequelize.models.GamePlayer.findAll({
                where: {
                    GameId: this.id
                },
                order: [
                    ['winPosition', 'ASC']
                ]
            })

            let leaderBoard = "### 🏆 Game Rankings 🏆"
            allPlayers.forEach(ep => {
                leaderBoard += `\n`
                switch (ep.winPosition) {
                    case 1:
                        leaderBoard += '🥇'
                        break;
                    case 2:
                        leaderBoard += '🥈'
                        break;
                    case 3:
                        leaderBoard += '🥉'
                        break;
                    default:
                        leaderBoard += `*${ep.winPosition}.*`
                        break
                }
                leaderBoard += ` <@${ep.PlayerId}>`
                if (typeof ep.stats.gamePoint !== 'undefined' && ep.stats.gamePoint != 0) {
                    leaderBoard += ` 🏆 Points: ${ep.stats.gamePoint}`
                }
                if (typeof ep.stats.killedSomeone !== 'undefined') {
                    leaderBoard += ` 🩸 Kills: ${ep.stats.killedSomeone}`
                }
                if (typeof ep.stats.wasKilled !== 'undefined') {
                    leaderBoard += ` ☠️ Deaths: ${ep.stats.wasKilled}`
                }
            })
            this.notify(leaderBoard)
        }
    }

    // set up the Sequelize fields
    Game.init(
        {
            id: {
                type: DataTypes.INTEGER,
                autoIncrement: true,
                allowNull: false,
                primaryKey: true
            },
            status: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: 'new'
            },
            musterTime: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: Sequelize.NOW
            },
            startTime: {
                type: DataTypes.DATE,
                allowNull: true
            },
            nextTickTime: {
                type: DataTypes.DATE,
                allowNull: true
            },
            minutesPerActionDistro: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 60 * 12
            },
            boardWidth: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 20
            },
            boardHeight: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 20
            },
            winningPlayerId: {
                type: DataTypes.STRING,
                allowNull: true
            },
            minimumPlayerCount: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 2
            },
            boardObjectLocations: {
                type: DataTypes.JSON,
                allowNull: true,
                defaultValue: []
            },
            suddenDeathRound: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0
            }
        },
        { sequelize }
    )

    return Game

}