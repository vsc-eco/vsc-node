const fs = require('fs');
const path = require('path');

// require all the cbor utils and then import this file elsewhere so that
// the files are forefully "included" in the output
const normalizedPath = path.join(__dirname);
fs.readdirSync(normalizedPath).forEach((file) => {
    if (file.endsWith('.js')) {
        require(`./cborg_utils/${file}`);
        require(`./cborg_utils/json/${file}`);
    }
});
