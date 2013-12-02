#!/usr/bin/env node

"use strict";

var fs = require ("fs");
var readLine = require ("readline");
var tftp = require ("../lib");
var argp = require ("argp");

var client;
var rl;
var sigint;
var read;
var write;

//The main parser is not cached
argp.createParser ()
		.readPackage (__dirname + "/../package.json")
		.usages (["ntftp [options] <host>[:<port>]"])
		.allowUndefinedArguments ()
		.on ("argument", function (argv, argument, ignore){
			if (argv.server) this.fail ("Too many arguments");
			argument = argument.split (":");
			argv.server = {
				address: argument[0],
				port: argument[1]
			};
			ignore ();
		})
		.on ("end", function (argv){
			if (!argv.server) this.fail ("Missing server address");
			createClient (argv);
		})
		.footer ("By default this client sends some known option extensions " +
						"trying to achieve the best performance. If the remote server " +
						"doesn't support option extensions, it automatically fallbacks " +
						"to a pure RFC 1350 compliant TFTP client implementation.")
		.body ()
				.text ("Once ntftp is running, it shows a prompt and recognizes the " +
						"following commands:")
				.text ("> get <remote> [<local>]", "  ")
				.text ("Gets a file from the remote server.", "    ")
				.text ("\n> put <local> [<remote>]", "  ")
				.text ("Puts a file to the remote server.", "    ")
				.text ("\nTo quit the program press ctrl-c two times.")
				
				.text ("\nExample:")
				.text ("$ ntftp localhost -w 4 --blksize 256", "  ")
				.text ("> get remote_file", "  ")
				.text ("> get --md5sum 1234 remote_file local_file", "  ")
				.text ("> put path/to/local_file remote_file", "  ")
				
				.text ("\nArguments:")
				.columns ("  <host>[:<port>]", "The address and port of the remote " +
						"server, eg.\n$ ntftp localhost:1234. Default port is 69")
				
				.text ("\nOptions:")
				.option ({ short: "b", long: "blksize", metavar: "SIZE",
						type: Number, description: "Sets the blksize option extension. " +
						"Valid range: [8, 65464]. Default is 1468, the size before IP " +
						"fragmentation in Ethernet environments"})
				.option ({ short: "r", long: "retries", metavar: "NUM",
						type: Number, description: "Number of retries before finishing " +
						"the transfer of the file due to an unresponsive server or a " +
						"massive packet loss"})
				.option ({ short: "t", long: "timeout", metavar: "MILLISECONDS",
						type: Number, description: "Sets the timeout option extension. " +
						"Default is 3000ms"})
				.option ({ short: "w", long: "windowsize", metavar: "SIZE",
						type: Number, description: "Sets the windowsize option " +
						"extension. Valid range: [1, 65535]. Default is 64"})
				
				.help ()
				.argv ();
				
function notifyError (str){
	console.error ("Error: " + str);
	rl.prompt ();
};

function createCommandParser (){
	//Don't produce errors when undefined arguments and options are
	//introduced, they are simply omitted
	return argp.createParser ()
			.main ()
					.allowUndefinedArguments ()
					.allowUndefinedOptions ()
					.on ("end", function (){
						notifyError ("Invalid command");
					})
					.on ("error", function (error){
						notifyError (error.message);
					})
			.command ("get", { trailing: { min: 1, max: 2 } })
					.allowUndefinedArguments ()
					.allowUndefinedOptions ()
					.on ("end", get)
					.on ("error", function (error){
						notifyError (error.message);
					})
			.command ("put", { trailing: { min: 1, max: 2 } })
					.allowUndefinedArguments ()
					.allowUndefinedOptions ()
					.on ("end", put)
					.on ("error", function (error){
						notifyError (error.message);
					});
};

function createClient (argv){
	var parser = createCommandParser ();

	//Default values are not checked in the cli layer. If they are not valid they
	//are set to their default values silently
	client = tftp.createClient ({
		hostname: argv.server.address,
		port: argv.server.port,
		blockSize: argv.blksize,
		retries: argv.retries,
		timeout: argv.timeout,
		windowSize: argv.windowsize
	});
	
	var timer;
	var again = function (){
		timer = setTimeout (function (){
			timer = null;
			sigint = false;
		}, 3000);
		
		console.log ("\n(^C again to quit)");
		rl.line = "";
		rl.prompt ();
	};
	var completions = ["get ", "put "];
	
	//Start prompt
	rl = readLine.createInterface ({
		input: process.stdin,
		output: process.stdout,
		completer: function (line){
			var hits = completions.filter (function (command){
				return command.indexOf (line) === 0;
			});
			return [hits.length ? hits : [], line];
		}
	});
	rl.setPrompt ("> ", 2);
	rl.on ("line", function (line){
		if (!line) return rl.prompt ();
		parser.argv (line.split (" ").filter (function (word){
			return word;
		}));
	});
	rl.on ("SIGINT", function (){
		if (timer) process.exit ();
		
		sigint = true;
		
		//Abort the current transfer
		if (read){
			read.ws.on ("finish", function (){
				var local = read.local;
				read = null;
				fs.unlink (local, again);
			});
			read.gs.abort ();
		}else if (write){
			
		}else{
			again ();
		}
	});
	rl.prompt ();
};

function get (argv){
	try{
		client._checkRemote (argv.get[0]);
	}catch (e){
		return notifyError (e.message);
	}
	
	var local = argv.get[1] || argv.get[0];
	
	//Check if local is a dir and prevent to start a request
	fs.stat (local, function (error, stats){
		if (error){
			if (error.code !== "ENOENT") return notifyError (error.message);
		}else if (stats.isDirectory ()){
			return notifyError ("The local file is a directory");
		}
		
		read = {};
		read.local = local;
		
		var getError = false;
		
		read.ws = fs.createWriteStream (read.local)
				.on ("error", function (error){
					read.gs.on ("end", function (){
						read = null;
						fs.unlink (local, function (){
							notifyError (error.message);
						});
					});
					read.gs.abort ();
				})
				.on ("finish", function (){
					//If sigint, the current transfer has been aborted and the finish
					//event is handled in another place
					//If getError, the get stream has failed and automatically closes the
					//underlying stream
					if (sigint || getError) return;
					read = null;
					rl.prompt ();
				});
		
		read.gs = client.createGetStream (argv.get[0]);
		read.gs
				.on ("error", function (error){
					fs.unlink (read.local, function (){
						getError = true;
						read.ws.end ();
						read = null;
						notifyError (error.message);
					});
				})
				.on ("progress", function (progress){
					//TODO
				})
				.pipe (read.ws);
	});
};

function put (argv){
	write = {};
	
	
};