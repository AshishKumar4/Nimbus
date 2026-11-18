export const version = '5.4.8';

export const files = {
  'script.lua': `local project = require('project')
local input = assert(io.open('input.txt', 'r'))
local value = input:read('*l')
assert(input:close())
local line = assert(io.read('*l'))
local output = assert(io.open('output.txt', 'w'))
assert(output:write(project.combine(value, line), '\\n'))
assert(output:close())
print(table.concat({arg[0], arg[1], arg[2]}, '|'))
`,
  'project.lua': `return { combine = function(a, b) return a .. ':' .. b end }
`,
  'input.txt': 'relative read\n',
  'failure.lua': `local ok, message = pcall(function() error('caught', 0) end)
assert(not ok and message == 'caught')
io.stderr:write('lua fixture: nonzero\\n')
os.exit(23)
`,
  'wait.lua': `io.stdout:write('LUA_READY\\n')
io.stdout:flush()
local line = assert(io.read('*l'))
print(line)
`,
  'spin.lua': `io.stdout:write('LUA_READY\\n')
io.stdout:flush()
while true do end
`,
};

export const successCommand = `printf 'piped input\\n' | lua script.lua 'two words' second && cat output.txt`;
export const failureCommand = 'lua -E failure.lua';
export const success = { exitCode: 0, stdout: 'script.lua|two words|second\nrelative read:piped input\n', stderr: '' };
export const failure = { exitCode: 23, stdout: '', stderr: 'lua fixture: nonzero\n' };
