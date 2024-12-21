const { Sequelize, DataTypes, Model } = require('sequelize')

module.exports = function (sequelize) {

    class GamePlayer extends Model {
        
    }

    // set up the Sequelize fields
    GamePlayer.init(
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
                defaultValue: 'alive'
            },
            health: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 3
            },
            actions: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 3
            },
            range: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 2
            },
            positionX: {
                type: DataTypes.INTEGER,
                allowNull: true
            },
            positionY: {
                type: DataTypes.INTEGER,
                allowNull: true
            },
            deathTime: {
                type: DataTypes.DATE,
                allowNull: true
            },
            winPosition: {
                type: DataTypes.INTEGER,
                allowNull: true
            },
            juryVotesToSpend: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0
            },
            juryVotesAgainst: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0
            },
            stats: {
                type: DataTypes.JSON,
                allowNull: false,
                defaultValue: {}
            }
        },
        { sequelize }
    )

    return GamePlayer

}