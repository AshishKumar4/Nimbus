export class StringDecoder {
    decoder;
    constructor(encoding) {
        const enc = (encoding || 'utf8').toLowerCase().replace('-', '');
        const map = {
            utf8: 'utf-8',
            utf16le: 'utf-16le',
            latin1: 'latin1',
            ascii: 'ascii',
            binary: 'latin1',
        };
        this.decoder = new TextDecoder(map[enc] || 'utf-8');
    }
    write(buffer) {
        return this.decoder.decode(buffer, { stream: true });
    }
    end(buffer) {
        if (buffer)
            return this.decoder.decode(buffer);
        return this.decoder.decode();
    }
}
export default { StringDecoder };
