const fs = require('fs');
const path = require('path');

const normalizedPath = path.join(__dirname);
fs.readdirSync(normalizedPath).forEach((file) => {
    if (file.endsWith('.js')) {
        require(`./cborg_utils/${file}`);
        require(`./cborg_utils/json/${file}`);
    }
});
