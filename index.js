/**
 * Module dependencies
 */

var util = require('util');
var Readable = require('stream').Readable;
var _ = require('lodash');
var Streamifier = require('streamifier');
var rttc = require('rttc');
var Machine = require('machine');
var normalizeResponses = require('./helpers/normalize-responses');
var getOutputExample = require('./helpers/get-output-example');


/**
 * machine-as-action
 *
 * Build a conventional controller action (i.e. route handling function)
 * from a machine definition.  This wraps the machine in a function which
 * negotiates exits to the appropriate response behavior, and passes in all
 * of the request parameters as inputs, as well as a few other useful properties
 * on `env` including:
 *  • req
 *  • res
 *
 *
 *
 * Usage:
 * ------------------------------------------------------------------------------------------------
 * @param  {Dictionary} optsOrMachineDef
 *           @required {Dictionary} machine
 *                       A machine definition.
 *
 *           @optional {Dictionary} responses
 *                       A set of static/lift-time response customizations.
 *                       Each key refers to a particular machine exit, and each
 *                       value is a dictionary of settings.
 *                       @default {}
 *
 *                       e.g.
 *                       {
 *                         success: {
 *                           responseType: 'view',       // ("view"|"redirect"|"")
 *                           viewTemplatePath: 'pages/homepage', // (only relevant if `responseType` is "view")
 *                           statusCode: 204             // any valid HTTP status code
 *                         }
 *                       }
 *
 *                       Note that these additional exit-specific response customizations may alternatively
 *                       be included inline in the exits of the machine definition (purely for convenience).
 *
 *
 *           @optional {Array} files
 *                     An array of input code names identifying inputs which expect to
 *                     receive file uploads instead of text parameters. These file inputs
 *                     must have `example: '==='`, but they needn't necessarily be
 *                     `required`.
 *                     @default  []
 *
 *                     e.g.
 *                     [ 'avatar' ]
 *
 *
 *
 *           @optional {String} urlWildcardSuffix
 *                     if '' or unspecified, then there is no wildcard suffix.  Otherwise,
 *                     this is the code name of the machine input which is being referenced
 *                     by the pattern variable serving as the wildcard suffix.
 *                     @default ''
 *
 *                     e.g.
 *                     'docPath'
 *
 *           @optional {Boolean} disableXExitHeader
 *                     if set, then do not set the `X-Exit` response header for any exit.
 *                     @default false
 *
 *           @optional {Boolean} disableDevelopmentHeaders
 *                     if set, then do not set headers w/ exit info during development.
 *                     Development headers include:
 *                       • `X-Exit-Friendly-Name`
 *                       • `X-Exit-Description`
 *                       • `X-Exit-Extended-Description`
 *                       • `X-Exit-More-Info-Url`
 *                       • `X-Exit-Output-Friendly-Name`
 *                       • `X-Exit-Output-Description`
 *                     These development headers are never shown in a production env
 *                     (i.e. when process.env.NODE_ENV === 'production') or when they
 *                     are not relevant.
 *                     @default false
 *
 *           @optional {Number} simulateLatency
 *                     if set, then simulate a latency of the specified number of milliseconds (e.g. 500)
 *                     @default 0
 *
 *           @optional {Boolean} logUnexpectedOutputFn
 *                     An optional override function to call when any output other than `undefined` is
 *                     received from a void exit (i.e. an exit w/ no outputExample).
 *                     @default (use `sails.log.warn()` if available, or `console.warn()` otherwise.)
 *
 *
 * -OR-
 *
 *
 * @param  {Dictionary} optsOrMachineDef
 *                       A machine definition.
 *
 *===
 *
 * @return {Function}
 *         @param {Request} req
 *         @param {Response} res
 * ------------------------------------------------------------------------------------------------
 */

module.exports = function machineAsAction(optsOrMachineDef) {

  optsOrMachineDef = optsOrMachineDef||{};

  // Use either `optsOrMachineDef` or `optsOrMachineDef.machine` as the node machine definition.
  // If `optsOrMachineDef.machine` is truthy, we'll use that as the machine definition.
  // Otherwise, we'll understand the entire `optsOrMachineDef` dictionary to be the machine
  // definition.  All other miscellaneous options are whitelisted.
  var machineDef;
  var options;
  var MISC_OPTIONS = [
    'files',
    'urlWildcardSuffix',
    'disableDevelopmentHeaders',
    'disableXExitHeader',
    'simulateLatency',
    'logUnexpectedOutputFn',
    'responses'//<< deprecated, will be removed soon!
  ];
  if (!optsOrMachineDef.machine) {
    machineDef = optsOrMachineDef;
    options = _.pick(optsOrMachineDef, MISC_OPTIONS);
  }
  else {
    machineDef = optsOrMachineDef.machine;
    options = _.pick(optsOrMachineDef, MISC_OPTIONS);
  }

  if (!_.isObject(machineDef)) {
    throw new Error('Consistency violation: Machine definition must be provided as a dictionary.');
  }


  // Set up default options:
  options = _.defaults(options, {
    simulateLatency: 0,
    // Note that the default implementation of `logUnexpectedOutputFn` is inline below
    // (this is so that it has closure scope access to `req._sails`)
  });


  // If a function was provided, freak out.
  // (Unless this is a wet machine-- in which case it's ok)
  if (_.isFunction(machineDef)) {

    // If this is clearly an already "-as-action"-ified thing, then freak out in a more helpful way.
    if (machineDef.IS_MACHINE_AS_ACTION) {
      var doubleWrapErr = new Error('Cannot build action: Provided machine definition appears to have already been run through `machine-as-action`!');
      doubleWrapErr.code = 'E_DOUBLE_WRAP';
      throw doubleWrapErr;
    }
    // Otherwise, if this is a wet machine, that's OK-- we know how to handle it.
    else if (machineDef.isWetMachine) {
      // No worries.  It's ok.  Keep going.
    }
    // Otherwise just freak out.
    else {
      var invalidMachineDefErr = new Error('Cannot build action: Provided machine definition must be a dictionary, with an `fn`.  See http://node-machine.org/spec/machine for details.');
      invalidMachineDefErr.code = 'E_INVALID_MACHINE_DEF';
      throw invalidMachineDefErr;
    }
  }
  // --•

  // Extend a default def with the actual provided def to allow for a laxer specification.
  machineDef = _.extend({
    identity: machineDef.friendlyName ? _.kebabCase(machineDef.friendlyName) : 'anonymous-action',
    inputs: {},
    exits: {},
  }, machineDef);

  // If no `fn` was provided, dynamically build a stub fn that always responds with `success`,
  // using the `example` as output data, if one was specified.
  if (!machineDef.fn) {
    machineDef.fn = function (inputs, exits, env) {

      // This is a generated `fn`.
      // (Note that this is fine for production in some cases-- e.g. static views.)

      // Look up the output example for the success exit.
      var successExitOutputExample = getOutputExample({
        machineDef: machineDef,
        exitCodeName: 'success'
      });

      // If there's no output example, just exit through the success exit w/ no output.
      // (This is fine for production.  Because static views.)
      if (_.isUndefined(successExitOutputExample)) {
        return exits.success();
      }
      // Otherwise, still exit success, but use the output example (i.e. an exemplar)
      // as fake data.  This will be used as the locals, response data, or redirect URL
      // (depending on the exit's responseType, of course.)
      else {

        // But if you're in production, since this would respond with
        // a stub (i.e. fake data) then log a warning about this happening.
        // (since you probably don't actually want this to happen)
        if (process.env.NODE_ENV.match(/production/i)) {

          // Set a header to as a debug flag indicating this is just a stub.
          env.res.set('X-Stub', machineDef.identity);

          console.warn('Using stub implementation for action (`'+machineDef.identity+'`) because it has no `fn`!\n'+
          'That means the output sent from this action will be completely fake!  To do this, `machine-as-action` '+
          'is using the `outputExample` from the success exit and using that as output.\n'+
          '(This warning is being logged because you are in a production environment according to NODE_ENV)');
        }

        return exits.success(successExitOutputExample);
      }


    };
  }

  // Build machine instance: a "wet" machine.
  // (This is just like a not-yet-configured "part" or "machine instruction".)
  //
  // This gives us access to the instantiated inputs and exits.
  var wetMachine = Machine.build(machineDef);

  // If any static response customizations/metadata were specified via `optsOrMachineDef`, combine
  // them with the exit definitions of the machine to build a normalized response mapping that will
  // be cached so it does not need to be recomputed again and again at runtime with each incoming
  // request. (e.g. non-dyamic things like status code, response type, view name, etc)
  var responses = normalizeResponses(options.responses || {}, wetMachine.exits);
  wetMachine.exits = responses;
  // Be warned that this caching is **destructive**.  In other words, if a dictionary was provided
  // for `options.responses`, it will be irreversibly modified.  Also the exits in the
  // machine definition will be irreversibly modified.


  //  ██████╗ ██╗   ██╗██╗██╗     ██████╗      █████╗  ██████╗████████╗██╗ ██████╗ ███╗   ██╗
  //  ██╔══██╗██║   ██║██║██║     ██╔══██╗    ██╔══██╗██╔════╝╚══██╔══╝██║██╔═══██╗████╗  ██║
  //  ██████╔╝██║   ██║██║██║     ██║  ██║    ███████║██║        ██║   ██║██║   ██║██╔██╗ ██║
  //  ██╔══██╗██║   ██║██║██║     ██║  ██║    ██╔══██║██║        ██║   ██║██║   ██║██║╚██╗██║
  //  ██████╔╝╚██████╔╝██║███████╗██████╔╝    ██║  ██║╚██████╗   ██║   ██║╚██████╔╝██║ ╚████║
  //  ╚═════╝  ╚═════╝ ╚═╝╚══════╝╚═════╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
  //

  /**
   * `_requestHandler()`
   *
   * At runtime, this code will be invoked each time the router receives a request and sends it to this action.
   * --------------------------------------------------------------------------------------------------------------
   * @param  {Request} req
   * @param  {Response} res
   */
  var action = function _requestHandler(req, res) {

    // Set up a local variable that will be used to hold the "live machine"
    // (which is a lot like a configured part or machine instruction)
    var liveMachine;


    // Validate `req` and `res`
    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Note: we really only need to do these checks once, but they're a neglible hit to performance,
    // and the extra µs is worth it to ensure continued compatibility when coexisting with other
    // middleware, policies, frameworks, packages, etc. that might tamper with the global `req`
    // object (e.g. Passport).
    ///////////////////////////////////////////////////////////////////////////////////////////////////

    // Sails/Express App Requirements
    if (!res.json) {
      throw new Error('`machine-as-action` requires `res.json()` to exist (i.e. a Sails.js or Express app)');
    }
    if (!res.send) {
      throw new Error('`machine-as-action` requires `res.send()` to exist (i.e. a Sails.js or Express app)');
    }


    // Specify arguments (aka "input configurations") for the machine.
    ///////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Machine arguments can be derived from any of the following sources:
    //
    //  (1) TEXT PARAMETERS:
    //      Use a request parameter as an argument.
    //      - Any conventional Sails/Express request parameter is supported;
    //        i.e. from any combination of the following sources:
    //       ° URL pattern variables (match groups in path; e.g. `/monkeys/:id/uploaded-files/*`)
    //       ° The querystring (e.g. `?foo=some%20string`)
    //       ° The request body (may be URL-encoded or JSON-serialized)
    //
    //  (2) FILES:
    //      Use one or more incoming file upstreams as an argument.
    //      - Upstreams are multifile upload streams-- they are like standard multipart file upload
    //        streams except that they support multiple files at a time.  To manage RAM usage, they
    //        support TCP backpressure.  Upstreams also help prevent DoS attacks by removing the
    //        buffering delay between the time a potentially malicious file starts uploading and
    //        when your validation logic runs.  That means no incoming bytes are written to disk
    //        before your code has had a chance to take a look.  If your use case demands it, you
    //        can even continue to perform incremental validations as the file uploads (i.e. to
    //        scan for malicious code or unexpectedly formatted data) or gradually pipe the stream
    //        to `/dev/null` (a phony destination) as a honeypot to fool would-be attackers into
    //        thinking their upload was successful.
    //      - Upstream support is implemented by the Skipper body parser (a piece of middleware).
    //        Skipper is the default body parser in Sails, but it is compatible with Express,
    //        Connect, Hapi, or any other framework that exposes a conventional `req`/`res`/`next`
    //        interface for its middleware stack.
    //        body parser. event streams that emit multipart file upload streams) via Skipper.
    //      - Any receiving input(s) may continue to be either required or optional, but they must
    //        declare themselves refs by setting `example: '==='`. If not, then `machine-as-action`
    //        will refuse to rig this machine.
    //
    //  (3) HEADERS:
    //      Use an HTTP request headers as an argument.   (-NOT YET SUPPORTED-)
    //      - Any receiving input(s) may continue to be either required or optional, but they must
    //        declare a string example.
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////

    // Build `argins` (aka input configurations), a dictionary that maps each input's codeName to the
    // appropriate argument.
    var argins = _.reduce(wetMachine.inputs, function (memo, inputDef, inputCodeName) {

      // If this input is called out by the `urlWildcardSuffix`, then we understand it as "*" from the
      // URL pattern.  This is indicating it's special; that it represents a special, agressive kind of match
      // group that sometimes appears in URL patterns.  This special match group is known as a "wildcard suffix".
      // It is just like any other match group except that it (1) can match forward slashes, (2) can only appear
      // at the very end of the URL pattern, and (3) there can only be one like it per route.
      //
      // Note that we compare against the code name in the input definition.  The `urlWildcardSuffix` provided to
      // machine-as-action should reference the c-input by code name, not by any other sort of ID (i.e. if you are
      // using a higher-level immutable ID abstraction, rewrite the urlWildcardSuffix to the code name beforehand)
      if (options.urlWildcardSuffix && options.urlWildcardSuffix === inputCodeName ) {
        memo[inputCodeName] = req.param('0');
      }
      // Otherwise, this is just your standard, run of the mill parameter.
      else {
        memo[inputCodeName] = req.param(inputCodeName);
      }

      return memo;
    }, {});



    // Handle `files` option (to provide access to upstreams)
    if (_.isArray(options.files)) {
      if (!req.file) {
        throw new Error('In order to use the `files` option, `machine-as-action` requires `req.file()` to exist (i.e. a Sails.js, Express, or Hapi app using Skipper)');
      }
      _.each(options.files, function (fileParamName){
        // Supply this upstream as an argument for the specified input.
        argins[fileParamName] = req.file(fileParamName);
        // Also bind an `error` event so that, if the machine's implementation (`fn`)
        // doesn't handle the upstream, or anything else goes wrong with the upstream,
        // it won't crash the server.
        argins[fileParamName].on('error', function (err){
          console.error('Upstream (file upload: `'+fileParamName+'`) emitted an error:', err);
        });
      });
    }

    // Eventually, we may consider implementing support for sourcing inputs from headers.
    //  (if so, we'll likely map as closely as possible to Swagger's syntax --
    //   not just for familiarity, but also to maintain and strengthen the underlying
    //   conventions)


    // Pass argins to the machine.
    liveMachine = wetMachine.configure(argins);


    // Build and set `env`
    ///////////////////////////////////////////////////////////////////////////////////////////////

    // Provide `env.req` and `env.res`
    var env = {
      req: req,
      res: res
    };

    // If this is a Sails app, provide `env.sails` for convenience.
    if (req._sails) {
      env.sails = req._sails;
    }

    // Expose `env` in machine `fn`.
    liveMachine.setEnv(env);



    // Now prepare some exit callbacks that map each exit to a particular response.
    /////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Just like a machine's `fn` _must_ call one of its exits, this action _must_ send a response.
    // But it can do so in a number of different ways:
    //
    //  (1) ACK:           Do not send a response body.
    //  /\                 - Useful in situations where response data is unnecessary/wasteful,
    //  || nice-to-have      e.g. after successfully updating a resource like `PUT /discoparty/7`.
    //  || like plaintext  - The status code and any response headers will still be sent.
    //  || kinda advanced  - Even if the machine exit returns any output, it will be ignored.
    // (can use "" (aka standard) to achieve same effect)
    //
    //  (2) PLAIN TEXT:    Send plain text.
    //                     - Useful for sending raw data in a format like CSV or XML.
    //  /\                 - The *STRING* output from the machine exit will be sent verbatim as the
    //  || prbly wont be    response body. Custom response headers like "Content-Type" can be sent
    //  || implemented      using `env.res.set()` or mp-headers.  For more info, see "FILE" below.
    //  since you can just - If the exit does not guarantee a *STRING* output, then `machine-as-action`
    //  use "" to            will refuse to rig this machine.
    //  achieve the same
    //  effect.
    //
    //
    //  (3) JSON:          Send data encoded as JSON.
    //                     - Useful for a myriad of purposes; e.g. mobile apps, IoT devices, CLI
    //  /\                   scripts or daemons, SPAs (single-page apps) or any other webpage
    //  || nice-to-have      using AJAX (whether over HTTP or WebSockets), other API servers, and
    //  || but generally     pretty much anything else you can imagine.
    //  || achieveable w/  - The output from the machine exit will be stringified before it is sent
    //  || "".               as the response body, so it must be JSON-compatible in the eyes of the
    //  || Like plain text,  machine spec (i.e. lossless across JSON serialization and without circular
    //  || kinda advanced.   references).
    //  ||                 - That is, if the exit's output example contains any lamda (`->`) or
    //                       ref (`===`) hollows, `machine-as-action` will refuse to rig this machine.
    //
    //
    //  (4) "" (STANDARD): Send a response as versatile as you.
    //                     - Depending on the context, this might send plain text, download a file,
    //                       transmit data as JSON, or send no response body at all.
    //                     - Note that any response headers you might want to use such as `content-type`
    //                       and `content-disposition` should be set in the implementation of your
    //                       machine using `env.res.set()`.
    //                     - For advanced documentation on `env.res.set()`, check out Sails docs:
    //                         [Docs](http://sailsjs.org/documentation/reference/response-res/res-set)
    //                     - Or if you're looking for something higher-level:
    //                         [Install](http://node-machine.org/machinepack-headers/set-response-header)
    //
    //                     - If the |_output example_| guaranteed from the machine exit is:
    //                       • `null`/`undefined` - then that means there is no output.  Send only the
    //                         status code and headers (no response body).
    //                       • a number, boolean, generic dictionary, array, JSON-compatible (`*`), or a
    //                         faceted dictionary that DOES NOT contain ANY nested lamda (`->`) or ref
    //                         (`===`) hollows:
    //                            ...then the runtime output will be encoded with rttc.dehydrated() and
    //                               sent as JSON in the response body.  A JSON response header will be
    //                               automatically set ("Content-type: application/json").
    //                       • a lamda or a faceted dictionary that contains one or more lamda (`->`) and/or
    //                         ref (`===`) hollows:
    //                            ...then the runtime output will be encoded with rttc.dehydrate() and
    //                               sent as JSON in the response body.  A JSON response header will be
    //                               automatically set ("Content-type: application/json").
    //                               **************************************************************************
    //                               ******************************* WARNING **********************************
    //                               Since the output example indicates it might contain non-JSON-compatible
    //                               data, it is important to realize that transmitting this type of data in
    //                               the response body could be lossy.  For example, when rttc.dehydrate()
    //                               called, it toStrings functions into dehydrated cadavers andhumiliates
    //                               instances of JavaScript objects by wiping out their prototypal methods,
    //                               getters, setters, and any other hint of creativity that it finds. Objects
    //                               with circular references are spun around until they're dizzy, and their
    //                               circular references are replaced with strings (like doing util.inspect()
    //                               with a `null` depth).
    //                               **************************************************************************
    //                               **************************************************************************
    //                       • a ref:
    //                            ...then at runtime, the outgoing value will be sniffed.  If:
    //
    //                            (A) it is a READABLE STREAM of binary or UTF-8 chunks (i.e. NOT in object mode):
    //                                ...then it will be piped back to the requesting client in the response.
    //
    //                            (B) it is a buffer:
    //                                ...then it will be converted to a readable binary stream...
    //                                ...and piped back to the requesting client in the response.
    //                            -------------------------------------------------------------------------------------
    //                            ^ IT IS IMPORTANT TO POINT OUT THAT, WHEN PIPING EITHER BUFFERS OR STREAMS, THE
    //                              CONTENT-TYPE IS SET TO OCTET STREAM UNLESS IT HAS ALREADY BEEN EXPLICITLY SPECIFIED
    //                              USING `env.res.set()` (in which case it is left alone).
    //                            -------------------------------------------------------------------------------------
    //                       ----- Note about responding w/ plain text: ------------------------------------------------------
    //                       If you need to respond with programatically-generated plain text, and you don't want it
    //                       encoded as JSON (or if you MUST NOT encode it as JSON for some reason), then you just need
    //                       to convert the plain text string variable into a readable stream (`===`) and feed it into
    //                       standard response.
    //                       ----- ==================================== ------------------------------------------------------
    //
    //                             (C) Finally, if the outgoing value at runtime does not match one of the two criteria above
    //                                 (e.g. if it is a readable stream in object mode, or an array of numbers, or a haiku--
    //                                 OR LITERALLY ANYTHING ELSE):
    //                                 ...then the runtime output will be encoded with rttc.dehydrate() and
    //                                    sent as JSON in the response body.  A JSON response header will be
    //                                    automatically set to ("Content-type: application/json").
    //                               *** PLEASE SEE WARNING ABOVE ABOUT `rttc.dehydrate()` ***
    //
    //
    //  (5) REDIRECT:      Redirect the requesting user-agent to a different URL.
    //                     - When redirecting, no response body is sent.  Instead, the *STRING* output
    //                       from the machine is sent as the "Location" response header.  This tells
    //                       the requesting device to go talk to that URL instead.
    //                     - If the exit's output example is not a string, then `machine-as-action`
    //                       will refuse to rig this machine.
    //
    //
    //  (6) VIEW:          Responds with an HTML webpage.
    //                     - The dictionary output from the machine exit will be passed to the view
    //                       template as "locals".  Each key from this dictionary will be accessible
    //                       as a local variable in the view template.
    //                     - If the exit's output example is not a generic or faceted dictionary,
    //                       then `machine-as-action` will refuse to rig this machine.
    //
    //  (7) ERROR:         Handle an error with an appropriate response.
    //  /\                 - Useful exclusively for error handling.  This just calls res.serverError()
    //  || warning:          and passes through the output.  If there is no output, it generates a
    //  || this will not     nicer error message and sends that through instead.
    //  || necessarily be  - If this is a Sails app, the server error response method in `api/responses/`
    //  || available for     will be used, and in some cases it will render the default error page (500.ejs)
    //  || exits other     - Note that, if the requesting user-agent is accessing the route from a browser,
    //     than `error`      its headers give it away.  The "error" response implements content negotiation--
    //     exits.            if a user-agent clearly accessed the "error" response by typing in the URL
    //                       of a web browser, then it should see an error page (which error page depends on the output).
    //                       Alternately, if the same exact parameters were sent to the same exact URL,
    //                       but via AJAX or cURL, we would receive a JSON response instead.
    //
    /////////////////////////////////////////////////////////////////////////////////////////////////

    // We use a local variable (`exitAttempts`) as a spinlock.
    // (it tracks the code names of _which_ exit(s) were already triggered)
    var exitAttempts = [];

    var callbacks = {};
    _.each(_.keys(wetMachine.exits), function builtExitCallback(exitCodeName){

      // Build a callback for this exit that sends the appropriate response.
      callbacks[exitCodeName] = function respondApropos(output){

        // This spinlock protects against the machine calling more than one
        // exit, or the same exit twice.
        if (exitAttempts.length > 0) {
          console.warn('Consistency violation: When fulfilling this request (`'+req.method+' '+req.path+'`) '+
          'the action attempted to respond (i.e. call its exits) more than once!  An action should _always_ '+
          'send exactly one response.  This particular unexpected extra response was attempted via the `'+exitCodeName+'` '+
          'exit.  It was ignored.  For debugging purposes, here is a list of all exit/response attempts made '+
          'by this action:',exitAttempts);
          return;
        }
        exitAttempts.push(exitCodeName);

        (function _waitForSimulatedLatencyIfRelevant(_cb){
          if (!options.simulateLatency) { return _cb(); }
          setTimeout(_cb, options.simulateLatency);
        })(function afterwards(){
          // Use a `try` to be safe, since this callback might be invoked in
          // an asynchronous execution context.
          try {

            // Unless being prevented with the `disableXExitHeader` option,
            // encode exit code name as the `X-Exit` response header.
            if (!options.disableXExitHeader) {
              res.set('X-Exit', exitCodeName);
            }

            // Unless the NODE_ENV environment variable is set to `production`,
            // or this has been manually disabled, send down all other available
            // metadata about the exit for use during development.
            if ( !process.env.NODE_ENV.match(/production/i) && !options.disableDevelopmentHeaders) {
              var responseInfo = responses[exitCodeName];
              if (responseInfo.friendlyName) {
                res.set('X-Exit-Friendly-Name', responseInfo.friendlyName);
              }
              if (responseInfo.description) {
                res.set('X-Exit-Description', responseInfo.description);
              }
              if (responseInfo.extendedDescription) {
                res.set('X-Exit-Extended-Description', responseInfo.extendedDescription);
              }
              if (responseInfo.moreInfoUrl) {
                res.set('X-Exit-More-Info-Url', responseInfo.moreInfoUrl);
              }
              // Only include output headers if there _is_ output and
              // this is a standard response:
              if (responseInfo.responseType === '' && !_.isUndefined(output)) {
                if (responseInfo.outputFriendlyName) {
                  res.set('X-Exit-Output-Friendly-Name', responseInfo.outputFriendlyName);
                }
                if (responseInfo.outputDescription) {
                  res.set('X-Exit-Output-Description', responseInfo.outputDescription);
                }
              }
              // Otherwise if this is a view response, include the view path.
              else if (responseInfo.responseType === 'view') {
                res.set('X-Exit-View-Template-Path', responseInfo.viewTemplatePath);
              }
            }
            // >-


            // If this is the handler for the error exit, and it's clear from the output
            // that this is a runtime validation error _from this specific machine_ (and
            // not from any machines it might call internally in its `fn`), then send back
            // send back a 400 (using the built-in `badRequest()` response, if it exists.)
            var isValidationError =
              exitCodeName === 'error' &&
              output.code === 'E_MACHINE_RUNTIME_VALIDATION' &&
              output.machineInstance === liveMachine;

            if (isValidationError) {
              // Sanity check:
              if (!_.isArray(output.errors)) { throw new Error('Consistency violation: E_MACHINE_RUNTIME_VALIDATION errors should _always_ have an `errors` array.'); }

              // Build a new error w/ more specific verbiage.
              // (stack trace is more useful starting from here anyway)
              var prettyPrintedValidationErrorsStr = _.map(output.errors, function (rttcValidationErr){
                return '  • '+rttcValidationErr.message;
              }).join('\n');
              var baseValidationErrMsg =
              'Received incoming request (`'+req.method+' '+req.path+'`), '+
              'but could not run action (`'+machineDef.identity+'`) '+
              'due to '+output.errors.length+' missing or invalid '+
              'parameter'+(output.errors.length>1?'s':'');
              var err = new Error(baseValidationErrMsg+':\n'+prettyPrintedValidationErrorsStr);
              err.code = 'E_MISSING_OR_INVALID_PARAMS';
              err.errors = output.errors;

              // Attach a toJSON function to the error.  This will be run automatically
              // when this error is being stringified.  This is our chance to make this
              // error easier to read/programatically parse from the client.
              err.toJSON = function (){
                // Include the error code and the array of RTTC validation errors
                // for easy programmatic parsing.
                var jsonReadyErr = _.pick(err, ['code', 'errors']);
                // And also include a more front-end-friendly version of the error message.
                var preamble =
                'The server could not fulfill this request (`'+req.method+' '+req.path+'`) '+
                'due to '+output.errors.length+' missing or invalid '+
                'parameter'+(output.errors.length>1?'s':'')+'.';

                // If NOT running in production, then provide additional details and tips.
                if (!process.env.NODE_ENV.match(/production/i)) {
                  jsonReadyErr.message = preamble+'  '+
                  '**This message and the following additional information will not '+
                  'be shown in production**:  '+
                  'Tip: Check your client-side code to make sure that the request data it '+
                  'sends matches the expectations of the corresponding parameters in your '+
                  'server-side route/action.  Also check that your client-side code sends '+
                  'data for every required parameter.  Finally, for programmatically-parseable '+
                  'details about each validation error, `.errors`. ';
                }
                // If running in production, use a message that is more terse.
                else {
                  jsonReadyErr.message = preamble;
                }
                return jsonReadyErr;
              };


              // Just send a 400 response with the error encoded as JSON.
              return res.json(400, err);
              // -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -
              // Note:
              // When Sails v1.0 is released, this (^) will check for `res.badRequest()`,
              // and call that custom response method instead (if it exists).
              //
              // But as of v0.12.4, Sails core marshals this error (e.g. `err`) before
              // passing it through to `res.badRequest()`.  This dehydrates it, which
              // is usually not a bad idea.  But it also causes our toJSON() logic to be
              // skipped.  And that part is kind of lame.
              //
              // Unfortunately, changing this in Sails would be one of the more insidious
              // sorts of breaking changes, and I'm not doing it until we publish the first
              // major version (v1.0).  So, for the time being, machine-as-action always
              // calls res.json() directly instead.
              //
              // For more information, see:
              //  • https://github.com/balderdashy/sails/commit/b8c3813281a041c0b24db381b046fecfa81a14b7#commitcomment-18455430
              //  • http://mikermcneil.com/post/148171019987/sails-v1-first-look
              //
              // ```
              // if (_.isFunction(res.badRequest)) {
              //   return res.badRequest(err);
              // }
              // else {
              //   return res.json(400, err);
              // }
              // ```
              // -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -
            }//</if :: machine runtime validation error (E_MACHINE_RUNTIME_VALIDATION)>


            // -•
            switch (responses[exitCodeName].responseType) {

              case 'error':
                if (!res.serverError) {
                  return res.send(500, '`machine-as-action` requires `res.serverError()` to exist (i.e. a Sails.js app with the responses hook enabled) in order to use the `error` response type.');
                }
                // Use our output as the argument to `res.serverError()`.
                var catchallErr = output;
                // ...unless there is NO output, in which case we build an error message explaining what happened and pass THAT in.
                if (_.isUndefined(output)) {
                  catchallErr = new Error(util.format('Action (triggered by a `%s` request to  `%s`) encountered an error, triggering its "%s" exit. No additional error data was provided.', req.method, req.path, exitCodeName) );
                }
                return res.serverError(catchallErr);

              ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
              // Currently here strictly for backwards compatibility-
              // this response type may be removed (or more likely have its functionality tweaked) in a future release:
              case 'status':
                console.warn('The `status` response type will be deprecated in an upcoming release.  Please use `` (standard) instead.');
                return res.send(responses[exitCodeName].statusCode);
              ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

              ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
              // Currently here strictly for backwards compatibility-
              // this response type may be removed (or more likely have its functionality tweaked) in a future release:
              case 'json':
                console.warn('The `json` response type will be deprecated in an upcoming release.  Please use `` (standard) instead.');
                return res.json(responses[exitCodeName].statusCode, output);
              ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


              case '':
                // • Undefined output example:  We take that to mean void...mostly (see below.)
                var outputExample = getOutputExample({ machineDef: wetMachine, exitCodeName: exitCodeName });
                if (_.isUndefined(outputExample)) {

                  // Expose a more specific varname for clarity.
                  var unexpectedOutput = output;

                  // Technically the machine `fn` could still send through data.
                  // No matter what, we NEVER send that runtime data to the response.
                  //
                  // BUT we still log that data to the console using `sails.log.warn()` if available
                  // (otherwise `console.warn()`).  We use an overridable log function to do this.
                  if (!_.isUndefined(unexpectedOutput)) {

                    try {
                      // If provided, use custom implementation.
                      if (!_.isUndefined(options.logUnexpectedOutputFn)) {
                        options.logUnexpectedOutputFn(unexpectedOutput);
                      }
                      // Otherwise, use the default implementation:
                      else {
                        var logMsg = 'Received incoming request (`'+req.method+' '+req.path+'`) '+
                                     'and ran action (`'+machineDef.identity+'`), which exited with '+
                                     'its `'+exitCodeName+'` response and the following data:\n'+
                                     util.inspect(unexpectedOutput, {depth: null})+
                                     '\n'+
                                     '(^^ this data was not sent in the response)';

                        if (_.isObject(req._sails) && _.isObject(req._sails.log) && _.isFunction(req._sails.log.warn)) {
                          req._sails.log.warn(logMsg);
                        }
                        else {
                          console.warn(logMsg);
                        }
                      }//</default implementation to handle logging unexpected output>
                    } catch (e) { console.warn('The configured log function for unexpected output (`logUnexpectedOutputFn`) threw an error.  Proceeding to send response anyway...  Error details:',e); }
                  }//</if there is unexpected output sent through callback within `fn` at runtime>

                  // >-
                  // Regardless of whether there's unexpected output or not...
                  //
                  // Send the response.
                  return res.send(responses[exitCodeName].statusCode);
                }

                // • Expecting ref:
                if (outputExample === '===') {
                  // • Readable stream
                  if (output instanceof Readable) {
                    res.status(responses[exitCodeName].statusCode);
                    return output.pipe(res);
                  }
                  // • Buffer
                  else if (output instanceof Buffer) {
                    res.status(responses[exitCodeName].statusCode);
                    return Streamifier.createReadStream(output).pipe(res);
                  }
                  // • else just continue on to our `res.send()` catch-all below
                }

                // • Anything else:  (i.e. rttc.dehydrate())
                return res.send(responses[exitCodeName].statusCode, rttc.dehydrate(output, true));


              case 'redirect':
                // If `res.redirect()` is missing, we have to complain.
                // (but if this is a Sails app and this is a Socket request, let the framework handle it)
                if (!_.isFunction(res.redirect) && !(req._sails && req.isSocket)) {
                  throw new Error('Cannot redirect this request because `res.redirect()` does not exist.  Is this an HTTP request to a conventional server (i.e. Sails.js/Express)?');
                }
                if (_.isUndefined(output)) {
                  return res.redirect(responses[exitCodeName].statusCode);
                }
                else {
                  return res.redirect(responses[exitCodeName].statusCode, output);
                }
                break;


              case 'view':
                // If `res.view()` is missing, we have to complain.
                // (but if this is a Sails app and this is a Socket request, let the framework handle it)
                if (!_.isFunction(res.view) && !(req._sails && req.isSocket)) {
                  throw new Error('Cannot render a view for this request because `res.view()` does not exist.  Are you sure this an HTTP request to a Sails.js server with the views hook enabled?');
                }

                res.statusCode = responses[exitCodeName].statusCode;

                if (_.isUndefined(output)) {
                  return res.view(responses[exitCodeName].viewTemplatePath);
                }
                else {
                  return res.view(responses[exitCodeName].viewTemplatePath, output);
                }
                break;


              default:
                if (!res.serverError) {
                  return res.send(500, 'Encountered unexpected error in `machine-as-action`: "unrecognized response type".  Please report this issue at `https://github.com/treelinehq/machine-as-action/issues`');
                }
                return res.serverError(new Error('Encountered unexpected error in `machine-as-action`: "unrecognized response type".  Please report this issue at `https://github.com/treelinehq/machine-as-action/issues`'));
            }//</switch>
          } catch (e) { return res.send(500, e); }
        });//</after: waitForSimulatedLatencyIfRelevant>

      };//</respondApropos>
    });//</each exit>

    // Then attach them and `.exec()` the machine.
    return liveMachine.exec(callbacks);

  };//</define action>

  // Set `IS_MACHINE_AS_ACTION` flag to prevent accidentally attempting to wrap the same thing twice.
  action.IS_MACHINE_AS_ACTION = true;

  // Finally, return the action.
  return action;
};


