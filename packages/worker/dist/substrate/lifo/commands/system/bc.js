function tokenize(input) {
    const tokens = [];
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (ch === ' ' || ch === '\t') {
            i++;
            continue;
        }
        if (ch === '\n') {
            tokens.push({ type: 'newline', value: '\n' });
            i++;
            continue;
        }
        if (ch >= '0' && ch <= '9' || ch === '.') {
            let num = '';
            while (i < input.length && (input[i] >= '0' && input[i] <= '9' || input[i] === '.')) {
                num += input[i++];
            }
            tokens.push({ type: 'number', value: num });
            continue;
        }
        if (ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch === '_') {
            let ident = '';
            while (i < input.length && (input[i] >= 'a' && input[i] <= 'z' || input[i] >= 'A' && input[i] <= 'Z' || input[i] >= '0' && input[i] <= '9' || input[i] === '_')) {
                ident += input[i++];
            }
            tokens.push({ type: 'ident', value: ident });
            continue;
        }
        if ('+-*/%^()='.includes(ch)) {
            tokens.push({ type: ch, value: ch });
            i++;
            continue;
        }
        // Skip unknown characters
        i++;
    }
    tokens.push({ type: 'eof', value: '' });
    return tokens;
}
class Parser {
    tokens;
    pos = 0;
    vars = {};
    scale = 0;
    constructor(tokens, vars, scale) {
        this.tokens = tokens;
        this.vars = vars;
        this.scale = scale;
    }
    getScale() { return this.scale; }
    peek() {
        return this.tokens[this.pos] || { type: 'eof', value: '' };
    }
    advance() {
        return this.tokens[this.pos++] || { type: 'eof', value: '' };
    }
    expect(type) {
        const tok = this.advance();
        if (tok.type !== type) {
            throw new Error(`expected ${type}, got ${tok.type}`);
        }
        return tok;
    }
    // expression = assignment
    parseExpression() {
        return this.parseAssignment();
    }
    // assignment = ident '=' assignment | additive
    parseAssignment() {
        if (this.peek().type === 'ident' && this.pos + 1 < this.tokens.length && this.tokens[this.pos + 1].type === '=') {
            const name = this.advance().value;
            this.advance(); // consume '='
            const value = this.parseAssignment();
            if (name === 'scale') {
                this.scale = Math.floor(value);
            }
            else {
                this.vars[name] = value;
            }
            return value;
        }
        return this.parseAdditive();
    }
    // additive = multiplicative (('+' | '-') multiplicative)*
    parseAdditive() {
        let left = this.parseMultiplicative();
        while (this.peek().type === '+' || this.peek().type === '-') {
            const op = this.advance().type;
            const right = this.parseMultiplicative();
            left = op === '+' ? left + right : left - right;
        }
        return left;
    }
    // multiplicative = power (('*' | '/' | '%') power)*
    parseMultiplicative() {
        let left = this.parsePower();
        while (this.peek().type === '*' || this.peek().type === '/' || this.peek().type === '%') {
            const op = this.advance().type;
            const right = this.parsePower();
            if (op === '*')
                left = left * right;
            else if (op === '/') {
                if (right === 0)
                    throw new Error('divide by zero');
                left = left / right;
            }
            else {
                if (right === 0)
                    throw new Error('divide by zero');
                left = left % right;
            }
        }
        return left;
    }
    // power = unary ('^' power)?  (right-associative)
    parsePower() {
        const base = this.parseUnary();
        if (this.peek().type === '^') {
            this.advance();
            const exp = this.parsePower();
            return Math.pow(base, exp);
        }
        return base;
    }
    // unary = '-' unary | primary
    parseUnary() {
        if (this.peek().type === '-') {
            this.advance();
            return -this.parseUnary();
        }
        return this.parsePrimary();
    }
    // primary = number | ident | ident '(' expr ')' | '(' expr ')'
    parsePrimary() {
        const tok = this.peek();
        if (tok.type === 'number') {
            this.advance();
            return parseFloat(tok.value);
        }
        if (tok.type === 'ident') {
            this.advance();
            // Function call
            if (this.peek().type === '(') {
                this.advance();
                const arg = this.parseExpression();
                this.expect(')');
                if (tok.value === 'sqrt') {
                    if (arg < 0)
                        throw new Error('square root of negative number');
                    return Math.sqrt(arg);
                }
                if (tok.value === 'length')
                    return String(Math.floor(arg)).length;
                throw new Error(`unknown function: ${tok.value}`);
            }
            // Variable
            if (tok.value === 'scale')
                return this.scale;
            return this.vars[tok.value] ?? 0;
        }
        if (tok.type === '(') {
            this.advance();
            const val = this.parseExpression();
            this.expect(')');
            return val;
        }
        throw new Error(`unexpected token: ${tok.type}`);
    }
}
function formatResult(value, scale) {
    if (scale === 0) {
        // Truncate to integer like real bc
        const truncated = value < 0 ? Math.ceil(value) : Math.floor(value);
        return String(truncated);
    }
    return value.toFixed(scale);
}
const command = async (ctx) => {
    const vars = {};
    let scale = 0;
    const processLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            return null;
        if (trimmed === 'quit')
            return 'quit';
        try {
            const tokens = tokenize(trimmed);
            const parser = new Parser(tokens, vars, scale);
            const result = parser.parseExpression();
            scale = parser.getScale();
            return formatResult(result, scale);
        }
        catch (e) {
            return `error: ${e.message}`;
        }
    };
    // Check for -e expression argument
    if (ctx.args.length >= 2 && ctx.args[0] === '-e') {
        const expr = ctx.args.slice(1).join(' ');
        const result = processLine(expr);
        if (result !== null && result !== 'quit') {
            ctx.stdout.write(result + '\n');
        }
        return 0;
    }
    // Check for file argument
    if (ctx.args.length > 0 && ctx.args[0] !== '-e') {
        const path = ctx.args[0];
        try {
            const content = ctx.vfs.readFileString(path);
            for (const line of content.split('\n')) {
                const result = processLine(line);
                if (result === 'quit')
                    return 0;
                if (result !== null) {
                    ctx.stdout.write(result + '\n');
                }
            }
            return 0;
        }
        catch {
            ctx.stderr.write(`bc: ${path}: No such file\n`);
            return 1;
        }
    }
    // Read from stdin
    if (ctx.stdin) {
        const content = await ctx.stdin.readAll();
        for (const line of content.split('\n')) {
            const result = processLine(line);
            if (result === 'quit')
                return 0;
            if (result !== null) {
                ctx.stdout.write(result + '\n');
            }
        }
    }
    return 0;
};
export default command;
