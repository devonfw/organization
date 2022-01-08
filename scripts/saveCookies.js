const fs = require("fs");
const path = require("path");


if (!fs.existsSync(path.resolve("./cookies"))) {
    fs.mkdirSync(path.resolve("./cookies"));
  }

if(process.argv[2] && process.argv[2].trim().length > 0) {
    var cookies = JSON.parse(decodeURIComponent(process.argv[2]));
    for (const domain in cookies) {
        if (Object.hasOwnProperty.call(cookies, domain)) {
            const domainCookies = cookies[domain];
            fs.writeFileSync(
              path.resolve("./cookies/" + domain + ".json"),
              JSON.stringify(domainCookies, null, 2)
            );
            
        }
    }
}
