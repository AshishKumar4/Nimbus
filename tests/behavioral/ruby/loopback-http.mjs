#!/usr/bin/env bun
// ruby/loopback-http — Ruby dials in-session ports.
//
// TCPSocket/Net::HTTP in a Nimbus session reach whatever is listening on a
// registered port, through the same loopback routing the shell's curl and
// node's patched fetch use. The port here is an ordinary `node server.js`
// and, separately, the session's own AI gateway — nothing about either is
// special-cased.

import {
  deleteSession, mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi, fetchPort,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/loopback-http';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const PORT = 8321;
const EXACT = 'ruby-loopback-body:é✓ {"n":42}';

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
let serverPid = 0;
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  await t.run('nimbus install ruby', 180_000);
  await t.run('mkdir -p /home/user/rb-loopback && cd /home/user/rb-loopback', 10_000);

  // An ordinary user server: no Nimbus awareness of any kind.
  await t.run(heredocCommand('server.js', [
    'const http = require("http");',
    'http.createServer((req, res) => {',
    '  if (req.url === "/big") {',
    '    res.writeHead(200, { "Content-Type": "text/plain" });',
    '    let i = 0;',
    '    const pump = () => {',
    '      while (i < 20000) { if (!res.write("line-" + (i++) + "-" + "x".repeat(200) + "\\n")) return res.once("drain", pump); }',
    '      res.end();',
    '    };',
    '    return pump();',
    '  }',
    '  let body = "";',
    '  req.on("data", (c) => { body += c; });',
    '  req.on("end", () => {',
    '    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });',
    `    res.end(req.method === "POST" ? "echo:" + body : ${JSON.stringify(EXACT)});`,
    '  });',
    `}).listen(${PORT});`,
  ].join('\n')), 10_000);

  {
    const { output } = await t.run('node server.js', 60_000);
    const stripped = stripAnsi(output);
    const m = stripped.match(/pid=(\d+)/);
    serverPid = m ? Number(m[1]) : 0;
    // The port proxy is the independent witness that the port is registered:
    // whatever Ruby reaches later has to be the same listener.
    const proxied = await fetchPort(sid, PORT, 'hello');
    a.check('node server.js is listening on a registered session port',
      serverPid > 0 && proxied.status === 200 && proxied.body === EXACT,
      `pid=${serverPid} status=${proxied.status} body=${JSON.stringify(proxied.body.slice(0, 200))} ${JSON.stringify(stripped.slice(-400))}`);
  }

  // 1. GET returns the body byte-exact.
  await t.run(heredocCommand('rb_get.rb', [
    'require "net/http"',
    'require "uri"',
    `body = Net::HTTP.get(URI("http://127.0.0.1:${PORT}/hello"))`,
    'puts "GET_LEN=#{body.bytesize}"',
    'puts "GET_BODY=#{body}"',
  ].join('\n')), 10_000);
  {
    const { output } = await t.run('ruby rb_get.rb', 120_000);
    const stripped = stripAnsi(output);
    a.check('Net::HTTP.get returns the port body byte-exact',
      stripped.includes(`GET_LEN=${Buffer.byteLength(EXACT)}`) && stripped.includes(`GET_BODY=${EXACT}`),
      JSON.stringify(stripped.slice(-800)));
  }

  // 2. POST with a body.
  await t.run(heredocCommand('rb_post.rb', [
    'require "net/http"',
    'require "uri"',
    `res = Net::HTTP.post(URI("http://127.0.0.1:${PORT}/submit"), '{"hello":"ruby"}', "Content-Type" => "application/json")`,
    'puts "POST_CODE=#{res.code}"',
    'puts "POST_BODY=#{res.body}"',
  ].join('\n')), 10_000);
  {
    const { output } = await t.run('ruby rb_post.rb', 120_000);
    const stripped = stripAnsi(output);
    a.check('Net::HTTP.post delivers the request body and reads the reply',
      /POST_CODE=200/.test(stripped) && /POST_BODY=echo:\{"hello":"ruby"\}/.test(stripped),
      JSON.stringify(stripped.slice(-800)));
  }

  // 3. The session AI gateway, reached exactly like any other port.
  //
  // The credential is NIMBUS_AI_TOKEN, not OPENAI_API_KEY. Sessions
  // deliberately do not seed OPENAI_API_KEY — that variable stays the user's,
  // because setting it would assert an OpenAI account this session can never
  // serve (session/ai.ts). Reading it asserted the opposite of the designed
  // behaviour and raised KeyError before any loopback was exercised at all.
  await t.run(heredocCommand('rb_gateway.rb', [
    'require "net/http"',
    'require "uri"',
    'require "json"',
    'base = ENV.fetch("OPENAI_BASE_URL")',
    'key = ENV.fetch("NIMBUS_AI_TOKEN")',
    'raw = Net::HTTP.get(URI("#{base}/models"))',
    'models = JSON.parse(raw) rescue nil',
    // Being told no account is connected still proves Ruby dialled the
    // gateway — it is the models behind it that are absent, which is a
    // property of the target, not of the loopback under test. Say so
    // distinctly so the runner skips this arm instead of failing it.
    'if models && models["error"]',
    '  puts "GATEWAY_UNCONNECTED=#{models.dig("error", "code")}"',
    '  puts "GATEWAY_REASON=#{models.dig("error", "message")}"',
    '  exit 0',
    'end',
    'ids = (models && models["data"] || []).map { |m| m["id"] }',
    'puts "MODELS=#{ids.length}"',
    'puts "MODEL_IDS=#{ids.first(5).join(",")}"',
    'if ids.empty?',
    '  puts "MODELS_RAW=#{raw[0, 400]}"',
    '  exit 1',
    'end',
    'uri = URI("#{base}/chat/completions")',
    'req = Net::HTTP::Post.new(uri)',
    'req["Content-Type"] = "application/json"',
    'req["Authorization"] = "Bearer #{key}"',
    'req.body = JSON.generate({ model: ids.first, messages: [{ role: "user", content: "Reply with exactly: PONG" }] })',
    'res = Net::HTTP.start(uri.hostname, uri.port) { |http| http.request(req) }',
    'puts "CHAT_CODE=#{res.code}"',
    'body = JSON.parse(res.body) rescue nil',
    'puts "CHAT_TEXT=#{body && body.dig("choices", 0, "message", "content")}"',
    'puts "CHAT_RAW=#{res.body[0, 300]}" unless res.code == "200"',
  ].join('\n')), 10_000);
  {
    const { output } = await t.run('ruby rb_gateway.rb', 180_000);
    const stripped = stripAnsi(output);
    const unconnected = stripped.match(/GATEWAY_UNCONNECTED=(\S+)/);
    if (unconnected) {
      const reason = (stripped.match(/GATEWAY_REASON=(.*)/) || [])[1] || '';
      console.log(`[${label}] SKIP the AI-gateway arm: the gateway answered `
        + `${unconnected[1]} — ${reason.trim()}`);
      console.log(`[${label}] the loopback dial itself succeeded; connecting `
        + 'Cloudflare is interactive by design, so a bearer-token target has '
        + 'no account. Every other arm below still runs.');
    } else {
      const models = stripped.match(/MODELS=(\d+)/);
      a.check('ruby lists the session AI gateway models',
        models !== null && Number(models[1]) > 0,
        JSON.stringify(stripped.slice(-900)));
      a.check('ruby completes a chat request through the AI gateway',
        /CHAT_CODE=200/.test(stripped) && /CHAT_TEXT=\S/.test(stripped),
        JSON.stringify(stripped.slice(-900)));
    }
  }

  // 4. A large response streams instead of materialising.
  await t.run(heredocCommand('rb_stream.rb', [
    'require "net/http"',
    'total = 0',
    'chunks = 0',
    'first = nil',
    `Net::HTTP.start("127.0.0.1", ${PORT}) do |http|`,
    '  http.request_get("/big") do |res|',
    '    res.read_body do |chunk|',
    '      total += chunk.bytesize',
    '      chunks += 1',
    '      first ||= chunk[0, 7]',
    '    end',
    '  end',
    'end',
    'puts "STREAM_BYTES=#{total} STREAM_CHUNKS=#{chunks} STREAM_FIRST=#{first}"',
  ].join('\n')), 10_000);
  {
    const { output } = await t.run('ruby rb_stream.rb', 180_000);
    const stripped = stripAnsi(output);
    const m = stripped.match(/STREAM_BYTES=(\d+) STREAM_CHUNKS=(\d+) STREAM_FIRST=(\S+)/);
    a.check('a large response streams back in successive chunks',
      m !== null && Number(m[1]) > 4_000_000 && Number(m[2]) > 10 && m[3] === 'line-0-',
      JSON.stringify(stripped.slice(-800)));
  }

  // 5. Timeout still runs its block (its watchdog Thread.new is unavailable here).
  await t.run(heredocCommand('rb_timeout.rb', [
    'require "timeout"',
    'puts "TIMEOUT_RESULT=#{Timeout.timeout(5) { 40 + 2 }}"',
    'started = Time.now',
    'sleep 0.2',
    'puts "SLEPT=#{(Time.now - started) >= 0.15}"',
  ].join('\n')), 10_000);
  {
    const { output } = await t.run('ruby rb_timeout.rb', 120_000);
    const stripped = stripAnsi(output);
    a.check('Timeout.timeout still runs its block and sleep still returns',
      /TIMEOUT_RESULT=42/.test(stripped) && /SLEPT=true/.test(stripped),
      JSON.stringify(stripped.slice(-800)));
  }

  // 6. The accept side: a plain stdlib TCPServer with an ordinary blocking
  //    accept loop. No Nimbus-specific entrypoint, no adapter, nothing that
  //    knows it is running in Nimbus.
  await t.run(heredocCommand('rb_tcpserver.rb', [
    'require "socket"',
    'server = TCPServer.new("0.0.0.0", 8322)',
    'served = 0',
    'loop do',
    '  sock = server.accept',
    '  served += 1',
    '  head = sock.gets("\\r\\n\\r\\n").to_s',
    '  body = "RUBY_TCP_OK n=#{served} " + head.lines.first.to_s.split(" ")[1].to_s',
    '  sock.write("HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: #{body.bytesize}\\r\\n\\r\\n#{body}")',
    '  sock.close',
    'end',
  ].join('\n')), 10_000);
  let tcpPid = 0;
  {
    const { output } = await t.run('ruby rb_tcpserver.rb', 120_000);
    const m = stripAnsi(output).match(/pid=(\d+)/);
    tcpPid = m ? Number(m[1]) : 0;
    const first = await fetchPort(sid, 8322, 'ping');
    const second = await fetchPort(sid, 8322, 'pong');
    a.check('a plain Ruby TCPServer accepts a connection and serves it',
      first.status === 200 && first.body === 'RUBY_TCP_OK n=1 /ping',
      `pid=${tcpPid} status=${first.status} body=${JSON.stringify(first.body.slice(0, 200))} ${JSON.stringify(stripAnsi(output).slice(-400))}`);
    a.check('and keeps serving: the accept loop resumes rather than restarting',
      second.status === 200 && second.body === 'RUBY_TCP_OK n=2 /pong',
      `status=${second.status} body=${JSON.stringify(second.body.slice(0, 200))}`);
  }
  if (tcpPid > 0) await t.run(`kill ${tcpPid}`, 10_000).catch(() => {});

  // 7. WEBrick, the highest-level consumer of the accept path.
  await t.run('gem install webrick', 180_000);
  await t.run(heredocCommand('rb_webrick.rb', [
    'require "webrick"',
    'server = WEBrick::HTTPServer.new(Port: 8323, BindAddress: "0.0.0.0",',
    '  Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN), AccessLog: [])',
    'server.mount_proc("/") { |req, res| res["Content-Type"] = "text/plain"; res.body = "WEBRICK_OK #{req.path}" }',
    'server.start',
  ].join('\n')), 10_000);
  let webrickPid = 0;
  {
    const { output } = await t.run('ruby rb_webrick.rb', 120_000);
    const m = stripAnsi(output).match(/pid=(\d+)/);
    webrickPid = m ? Number(m[1]) : 0;
    const proxied = await fetchPort(sid, 8323, 'served');
    a.check('WEBrick still serves a request byte-exact',
      proxied.status === 200 && proxied.body === 'WEBRICK_OK /served',
      `pid=${webrickPid} status=${proxied.status} body=${JSON.stringify(proxied.body.slice(0, 200))} ${JSON.stringify(stripAnsi(output).slice(-400))}`);
  }
  if (webrickPid > 0) await t.run(`kill ${webrickPid}`, 10_000).catch(() => {});

  if (serverPid > 0) await t.run(`kill ${serverPid}`, 10_000).catch(() => {});
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
