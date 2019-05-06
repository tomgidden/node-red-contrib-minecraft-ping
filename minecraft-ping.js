module.exports = function(RED) {
    "use strict";

    RED.nodes.registerType("minecraft-ping-server", function (config) {
        RED.nodes.createNode(this, config);
        this.host = config.host;
        this.port = config.port;
    });

    RED.nodes.registerType("minecraft-ping", function (config) {
        RED.nodes.createNode(this, config);
        var node = this;

        var mc = require("minecraft-protocol");

        node.on("input", function (msg) {

            this.server = RED.nodes.getNode(config.server);

            var params = {
                "host": msg.host || this.server.host || "localhost",
                "port": msg.port || this.server.port || 25565
            };

            mc.ping(params, function (err, data) {
                if (err) {
                    params.error = err;
                }
                else {
                    params.payload = data;
                }
                node.send(params);
            });
        });
    });
}
