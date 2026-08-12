// ─── Token types ───
export var TokenKind;
(function (TokenKind) {
    TokenKind[TokenKind["Word"] = 0] = "Word";
    TokenKind[TokenKind["Pipe"] = 1] = "Pipe";
    TokenKind[TokenKind["And"] = 2] = "And";
    TokenKind[TokenKind["Or"] = 3] = "Or";
    TokenKind[TokenKind["Semi"] = 4] = "Semi";
    TokenKind[TokenKind["Amp"] = 5] = "Amp";
    TokenKind[TokenKind["RedirectOut"] = 6] = "RedirectOut";
    TokenKind[TokenKind["RedirectAppend"] = 7] = "RedirectAppend";
    TokenKind[TokenKind["RedirectIn"] = 8] = "RedirectIn";
    TokenKind[TokenKind["RedirectReadWrite"] = 9] = "RedirectReadWrite";
    TokenKind[TokenKind["Heredoc"] = 10] = "Heredoc";
    TokenKind[TokenKind["HeredocStripTabs"] = 11] = "HeredocStripTabs";
    TokenKind[TokenKind["HeredocBody"] = 12] = "HeredocBody";
    TokenKind[TokenKind["RedirectErr"] = 13] = "RedirectErr";
    TokenKind[TokenKind["RedirectErrAppend"] = 14] = "RedirectErrAppend";
    TokenKind[TokenKind["RedirectAll"] = 15] = "RedirectAll";
    TokenKind[TokenKind["DoubleSemi"] = 16] = "DoubleSemi";
    TokenKind[TokenKind["LParen"] = 17] = "LParen";
    TokenKind[TokenKind["RParen"] = 18] = "RParen";
    TokenKind[TokenKind["Newline"] = 19] = "Newline";
    TokenKind[TokenKind["EOF"] = 20] = "EOF";
})(TokenKind || (TokenKind = {}));
