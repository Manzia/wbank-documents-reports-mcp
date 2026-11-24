// Loads a text file (the skills' Markdown) as a module whose default export is its content, as esbuild does.
module.exports = {
    process: (source) => ({ code: `module.exports = { __esModule: true, default: ${JSON.stringify(source)} };` }),
};
