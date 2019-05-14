module.exports = function(RED) {
    "use strict";

    // The storage key for persistent data
    var ctx_key_prefix = 'minecraft-ping-users_v1';

    RED.nodes.registerType("minecraft-ping-server", function (config) {
        RED.nodes.createNode(this, config);
        this.host = config.host;
        this.port = config.port;
    });

    RED.nodes.registerType("minecraft-ping", function (config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // Load configuration from config node
        var server = RED.nodes.getNode(config.server);

        // Initialise the third-party library
        var mc = require("minecraft-protocol");

        node.on("input", function (msg) {

            node.params = {
                "host": msg.host || server.host || "localhost",
                "port": msg.port || server.port || 25565
            };

            // Perform a simple Minecraft server ping and send the
            // results in a raw form to output.
            mc.ping(node.params, function (err, data) {
                msg.params = node.params;
                if (err)
                    msg.error = err;
                else
                    msg.payload = data;
                node.send(msg);
            });
        });
    });

    RED.nodes.registerType("minecraft-ping-users", function (config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // Load configuration from config node
        var server = RED.nodes.getNode(config.server);

        // Initialise the third-party library
        var mc = require("minecraft-protocol");

        // Set up persistent data
        var ctx;
        try {
            ctx = this.context().global;
            ctx.get(ctx_key_prefix);
        }
        catch (error) {
            console.warn("Persistent state '"+ctx_key_prefix+"' not set.");
            try {
                ctx.set(ctx_key_prefix, {});
            }
            catch (error) {
                console.error("Persistent state '"+ctx_key_prefix+"' failed to clear.");
            }
        }

        // Function to process the results of a ping, updating the
        // "state", ie. the user list.
        node.processPing = function (data, params) {

            // Iteration variables
            var i, id, name;
            var now = (new Date());

            // If we got valid data
            if (data && undefined !== data.players) {

                // Get the persistent user list
                var state = ctx.get(params.ctx_key);
                if (undefined === state)
                    state = {};

                // If there are users logged in...
                var onlines = {};
                if (undefined !== data.players.sample && 0 < data.players.sample.length) {

                    // Then record each logged-in user
                    for (i=0; i<data.players.sample.length; i++) {

                        // Get their details
                        var id = data.players.sample[i].id;

                        // Record their ID and name
                        onlines[id] = data.players.sample[i].name;

                        // If this is a new user...
                        if (undefined === state[id]) {
                            // Then just record their existence, so we "know
                            // about them" for the next phase of this
                            // process.
                            state[id] = true;
                        }
                    };
                }

                // For all known users...
                for (id in state) {
                    if (! state.hasOwnProperty(id)) continue;

                    if (true === state[id]) {
                        // Newly discovered user

                        state[id] = {
                            // We can't assume anything about their time
                            // online.  I guess we _could_ measure when we
                            // last ran this call, but that could give
                            // really bogus results -- days, even.
                            online_for: 0,

                            // Get their name from the new onlines
                            name: onlines[id],

                            online: true,
                            updated: now,
                            changed: now,

                            // History
                            history: [
                                { at: now, online: true }
                            ]
                        };
                    }
                    else {
                        // Persistent context storage can, at least at the
                        // time of writing, convert Dates to strings and
                        // fail to return them.  This should cast them back.
                        if ('string' === typeof state[id].changed)
                            state[id].changed = new Date(state[id].changed);
                        if ('string' === typeof state[id].updated)
                            state[id].updated = new Date(state[id].updated);
                        if (undefined !== state[id].history) {
                            for (var i; i<state[id].history.length; i++) {
                                if ('string' === typeof state[id].history[i].at)
                                    state[id].history[i].at = new Date(state[id].history[i].at);
                            }
                        }
                        else {
                            state[id].history = [];
                        }

                        if (undefined !== onlines[id]) {
                            // User is online

                            // Update their name, just in case it changed
                            state[id].name = onlines[id];

                            if (state[id].online) {
                                // Still online

                                // Assume they've been online since the last time
                                // we checked.  If this check has been infrequent,
                                // that might be a wrong assumption, so don't
                                // punish your kid based purely on this "fact".
                                state[id].online_for += now - state[id].updated;
                                state[id].updated = now;
                            }
                            else {
                                // Newly online

                                // Set `online_for`, assuming they logged in
                                // halfway between then and now
                                state[id].online_for = (now - state[id].updated)/2;
                                state[id].changed = now;
                                state[id].updated = now;
                                state[id].online = true;
                                state[id].history.unshift({online:true, at:now});
                            }
                        }
                        else {
                            // User is not online

                            if (state[id].online) {
                                // Newly logged-out

                                // Update `online_for`, assuming they logged out
                                // halfway between then and now
                                state[id].online_for += (now - state[id].updated)/2;
                                state[id].changed = now;
                                state[id].updated = now;
                                state[id].online = false;
                                state[id].history.unshift({online:false, at:now});
                            }
                            else {
                                // User is _and_ wasn't logged-in
                                state[id].updated = now;
                            }
                        }
                    }
                }

                // Update the persistent state of all users
                ctx.set(params.ctx_key, state);
                return state;
            }
            else {
                return 'Server data not valid';
            }
        };

        // Function to process the node's flow once the remote server has
        // been pinged and the state updated, or even if not.
        node.processMessage = function (msg, params, did_load) {

            // Clear any existing errors and payload
            delete msg.error;
            delete msg.payload;

            // Get persistent list of users
            try {
                var state = ctx.get(params.ctx_key);
            }
            catch (error) {
                msg.error = error;
                node.error(error);
                state = undefined;
            }

            if (undefined === state) {
                // Not run yet.
                msg.error = msg.error || 'State data is not loaded (yet)';
            }
            else if ('' === params.userid) {
                // Return all users' states
                msg.payload = state;
            }
            else {
                // Now we have to check the state list for the user with
                // this name or id.

                for (var id in state) {
                    if (! state.hasOwnProperty(id)) continue;

                    if (params.userid === id || params.userid === state[id].name) {
                        // Yeah, that worked.
                        msg.payload = state[id];
                        break;
                    }
                }

                // If not found in that loop...
                if (undefined === msg.payload) {

                    // User not in the state list

                    // If we _did load_ the user list (ie. not
                    // `msg.do_not_load`, and the ping worked)...
                    if (did_load) {

                        // Then we assume the user is not online.  We
                        // can't really judge `online_for` or `modified`.
                        msg.payload = {
                            name:    params.userid,
                            online:  false,
                            updated: (new Date()),
                            history: []
                        };
                    }
                    else {
                        // As we haven't updated the user list in this
                        // call, we can't be sure either way.
                        msg.error = 'User "'+params.userid+'" not (yet) known';
                    }
                }
            }

            if (undefined !== msg.error) {
                node.status({fill:"red", shape:"ring", text:msg.error});
            }
            else {
                node.status({fill:"green", shape:"dot", text:'Success'});
            }

            return msg;
        };

        // Handle a request, pinging unless told not to, and then deliver
        // the processed results for the requested users, or all users if
        // no specific user requested.
        node.on("input", function (msg) {

            // Catch exceptions, like a good boy.
            try {

                node.params = {
                    "host":        msg.host || server.host || "localhost",
                    "port":        msg.port || server.port || 25565,
                    "do_not_ping": !!(msg.do_not_ping || config.do_not_ping || false),
                    "userid":      config.userid || undefined
                };

                // Prepare a key for storing this server's user list state; as
                // contexts use '.' as key separators, convert these to
                // something else.
                var host = node.params.host.replace(/\./g, ':');
                node.params.ctx_key = ctx_key_prefix + '.' + host + ':' + node.params.port;

                // Make sure it's set up.
                try { ctx.get(node.params.ctx_key); }
                catch (error) {
                    try { ctx.set(node.params.ctx_key, {}); }
                    catch (error) {
                        node.error("Failed to store persistent state '"+node.params.ctx_key+"'");
                        return;
                    }
                }

                // Userid priority:  msg.userid > config.userid > msg.payload (if string) > '' (default)
                // A userid of '' means "all users" (an array of objects).
                // A userid can either be the Minecraft user's nickname, or their UUID-style ID.
                if (undefined !== msg.userid) {
                    node.params.userid = msg.userid;
                    delete msg.userid;
                }
                else if (undefined === node.params.userid) {
                    // Neither the node configuration or msg.userid have been set.

                    if ('string' === typeof msg.payload) {
                        // For ease-of-use, userid can be passed in the payload.
                        node.params.userid = msg.payload;
                    }
                    else {
                        // Default to use all
                        node.params.userid = '';
                    }
                }

                if (node.params.do_not_ping) {

                    // If `do_not_ping` is set, then just return the stored
                    // list.
                    msg = node.processMessage(msg, node.params, false);
                    node.send(msg);
                    return;
                }

                else if (undefined !== msg.fake_data) {
                    // Debugging...

                    // Process the data that was acquired
                    var ret = node.processPing(msg.fake_data, node.params);

                    if ('string' === typeof ret) {
                        msg.error = ret;
                    }
                    else {
                        // Process the node request for data
                        msg = node.processMessage(msg, node.params, true);
                        node.send(msg);
                    }
                }
                else {
                    // Perform the ping
                    mc.ping(node.params, function (err, data) {

                        // Copy the parameters into the message we'll reply
                        // with, for debugging.
                        msg.params = node.params;

                        if (err) {
                            msg.error = err;
                        }
                        else {
                            // Process the data that was acquired
                            try {
                                var ret = node.processPing(data, node.params);
                            } catch (error) {
                                node.error("Failed to process Minecraft ping data: "+error);
                                ret = error;
                            }

                            if ('string' === typeof ret) {
                                msg.error = ret;
                            }
                            else {
                                // Process the node request for data
                                try {
                                    msg = node.processMessage(msg, node.params, true);
                                    node.send(msg);
                                }
                                catch (error) {
                                    node.error("Failed to process message: "+error);
                                }
                            }
                        }

                        if (undefined !== msg.error) {
                            node.status({fill:"red",shape:"ring",text:msg.error});
                        }
                        else {
                            node.status({fill:"green",shape:"dot",text:'Success'});
                        }
                    });
                }
            }
            catch (error) {
                node.error(error);
            }
        });
    });
}
