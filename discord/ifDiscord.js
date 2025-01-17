module.exports = function (db) {
    const fs = require('node:fs');
    const path = require('node:path');
    const { Client, Collection, Events, GatewayIntentBits, ChannelType } = require('discord.js');


    // Create a new client instance
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.commands = new Collection();

    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        // Set a new item in the Collection with the key as the command name and the value as the exported module
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }

    client.on(Events.InteractionCreate, async interaction => {
        console.log(interaction);
        if (!interaction.isChatInputCommand()) return;

        const command = interaction.client.commands.get(interaction.commandName);
    
        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }
    
        try {
            await command.execute(interaction, db);
        } catch (error) {
            console.error(error);
            try {
                await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
            } catch (error2) {
                console.log("Error returning discord error response", error2)
            }
        }
    });

    // When the client is ready, run this code (only once)
    // We use 'c' for the event parameter to keep it separate from the already defined 'client'
    client.once(Events.ClientReady, c => {
        console.log(`Discord Client Ready! Logged in as ${c.user.tag}`);
    });

    //Event when a Discord Guild authorized the application to connect.
    client.on(Events.GuildCreate, async guild => {
        console.log("Joined a new guild: " + guild.name);
        const [g, created] = await db.Guild.upsert({
            id: guild.id,
            name: guild.name,
            icon: guild.icon
        });
    })

    //removed from a server
    client.on(Events.GuildDelete, async guild => {
        console.log("Left a guild: " + guild.name);
        
        const g = await db.Guild.findByPk(guild.id);
        if (g === null) {
          console.log('Could no find guild to disconnect');
        } else {
            g.gameChannelId = null
            g.isConnected = false
            g.currentGameId = null
            await g.save()
            console.log('Guild disconnect successful');
            //todo kill active game
        }
    })

    // Log in to Discord with your client's token
    client.login(process.env.DISCORD_BOT_TOKEN);

    return client
}