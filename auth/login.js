const session = require('express-session');
const jwt = require('jsonwebtoken');

module.exports = function (app, settings, db) {

    var DiscordStrategy = require('passport-discord').Strategy;
    var scopes = ['identify', 'guilds']; //removed: 'email', 

    const passport = require('passport');

    passport.serializeUser(function (user, done) { //TODO: remove sessions, cuz jwt...
        done(null, user);
    });

    passport.deserializeUser(function (user, done) {
        done(null, user);
    });


    app.use(session({
        secret: settings.sessionSecret,
        resave: false,
        saveUninitialized: false
      }));
      

    passport.use(new DiscordStrategy({
        clientID: settings.discord_oauth2_client_id,
        clientSecret: settings.discord_oauth2_client_secret,
        callbackURL: settings.apiUrl + settings.discordCallbackPath,
        scope: scopes
    },
        async function (accessToken, refreshToken, profile, cb) { //TODO: test is this async thinger works?
            console.log(profile)

            await saveUser(profile, refreshToken)

            const profileForSession = {
                username: profile.global_name,
                avatar: profile.avatar,
                // email: profile.email,
                id: profile.id
            }
            return cb(null, profileForSession);
        }));

    app.use(passport.authenticate('session'));

    app.get('/auth/discord', passport.authenticate('discord'));

    app.get(settings.discordCallbackPath, passport.authenticate('discord', {
        failureRedirect: '/'
    }), function (req, res) {
        const user = req.session.passport.user

        const jwtPayload = user
        res.redirect(settings.uiUrl + '/authResponse?jwt=' + jwt.sign(jwtPayload, settings.sessionSecret)) // Successful auth
    });

    const saveUser = async (discordProfile, refreshToken) => {
        
        const nameToUse = discordProfile.global_name
        if (nameToUse == null) {
            nameToUse = discordProfile.username
        }
        await db.Player.upsert({
            id: discordProfile.id,
            name: nameToUse,
            discriminator: discordProfile.discriminator,
            avatar: discordProfile.avatar            
        })

        //add or update Guilds
        const foundGuilds = []
        const associations = []
        discordProfile.guilds.forEach(guild => {
            foundGuilds.push({
                id: guild.id,
                name: guild.name,
                icon: guild.icon
            })

            const pg = {
                PlayerId: discordProfile.id,
                GuildId: guild.id,
                isAdmin: false
            }
            if (guild.isOwner) {
                pg.isAdmin = true
            }
            associations.push(pg)
        });
        await db.Guild.bulkCreate(foundGuilds, {
            updateOnDuplicate: ['name', 'icon']
        })


        await db.PlayerGuild.bulkCreate(associations, {}).catch(function (err) {
            console.log(err)
          })
    }

    const infightLogin = {
        passport: passport
    }

    return infightLogin
}