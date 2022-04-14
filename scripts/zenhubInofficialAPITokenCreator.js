/**
 * The official zenhub API currently does not support the operations that we need for modifying the boards automaticly
 * Therefore, the API for the frontend was used to achieve that.
 * The only downside is that we need a different token for that than the official API token.
 * To get the token we login to github, save the cookies, go to the zenhub login page and use the
 * github authentication method to get logged in.
 *
 * To login with github we need a verification from the gmail adress.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const url = require('url');
const imaps = require('imap-simple');

/**
 * This class offers the possibility to get an authentication token for zenhub.
 */
class ZenhubInofficialApiTokenCreator {
  /**
   * Constructor method
   * @param {string} ghUsername Username of the github account to login with
   * @param {string} ghPassword Passwird of the github account to login with
   * @param {string} mailUsername Username of the Google mail account to login with
   * @param {string} mailPassword Password of the Google mail account to login with
   */
  constructor(ghUsername, ghPassword, mailUsername, mailPassword) {
    this.browser;
    this.page;
    this.ghUsername = ghUsername;
    this.ghPassword = ghPassword;
    this.mailUsername = mailUsername;
    this.mailPassword = mailPassword;
  }

  /**
   * Returns the token of the zenhub API that is used.
   *
   * @param {string} username github user account to login with
   * @param {string} password Github user account password to login with
   * @param {string} mailUsername The username of the mail account Needed to download the 2FA verificaton token
   * @param {string} mailPassword  The passowrd of the mail account.
   * @return {string} The zenhub API token.
   */
  async getToken() {
    console.log(this.ghUsername);
    let token = undefined;
    this.browser = await puppeteer.launch();
    this.page = await this.browser.newPage();
    try {
      if (!fs.existsSync(path.resolve('./cookies'))) {
        fs.mkdirSync(path.resolve('./cookies'));
      }

      console.log('Go to Zenhub login page');
      await this.goto('https://app.zenhub.com');
      await this.page.waitForNetworkIdle({timeout: 60000}).catch((err) => {
        console.error(
            'Waiting for network timeout not possible. Continue in hope that the page has changed',
            err,
        );
      });
      console.log('Save cookies for later reuse');
      await this.saveCookies();

      if (this.page.mainFrame().url() == 'https://app.zenhub.com/login') {
        // Two possibilities for now. 
        console.log('Zenhub login page');
        await this.page.waitForSelector('.zhc-button--color-primary');
        console.log('Clicking on the login button');
        await this.page.click('.zhc-button--color-primary');
        await this.waitForZenhubLandingPage();
      } else if ( this.page.mainFrame().url().startsWith('https://auth.zenhub.com/login')) {
        console.log('On Auth page');
        await this.page.waitForSelector('button#github-login');
        console.log('Clicking on the login button');
        await this.page.click('button#github-login');
        await this.page.waitForNetworkIdle({timeout: 60000}).catch((err) => {
          console.error(
              'Waiting for network timeout not possible. Continue in hope that the page has changed',
              err,
          );
        });
        await this.authenticateGithub();
        await this.waitForZenhubLandingPage();
      } else {
        console.error('Zenhub login page expected');
      }

      const localStorage = await this.page.evaluate(() =>
        Object.assign({}, window.localStorage),
      );
      token = localStorage.api_token;
    } catch (e) {
      console.error(this.page.mainFrame().url());
      const bodyHTML = await this.page.evaluate(() => document.body.outerHTML);
      fs.writeFile('errorPageContent.html', bodyHTML, (err) => {
        console.error(err);
      });
      console.error(e);
    }

    await this.browser.close();
    return token;
  }

  /**
   * Move to another page and consider existing cookies of that page.
   * @param {string} targetUrl the url of the page to go to.
   */
  async goto(targetUrl) {
    const currentDomain = await this.saveCookies();

    const domain = url.parse(targetUrl).hostname;
    if (
      domain != currentDomain &&
      fs.existsSync(path.resolve('./cookies/' + domain + '.json'))
    ) {
      const cookiesString = fs.readFileSync(
          path.resolve('./cookies/' + domain + '.json'),
      );
      const cookies = JSON.parse(cookiesString);
      await this.page.setCookie(...cookies);
    }

    await this.page.goto(targetUrl);
  }

  /**
   * Save the cookies of the current page.
   * @return {string} the current domain url.
   */
  async saveCookies() {
    const currentDomain = url.parse(this.page.mainFrame().url()).hostname;
    const currentCookies = await this.page.cookies();
    fs.writeFileSync(
        path.resolve('./cookies/' + currentDomain + '.json'),
        JSON.stringify(currentCookies, null, 2),
    );
    return currentDomain;
  }

  /**
   * Authenticate using the given github account.
   * This method does all steps necessary to login to github via the github login screens.
   *
   * @param {string} username The username of the github account
   * @param {string} password The password of the github accountj
   * @param {string} mailUsername The username of the corresponding mail account for 2 FA verification code.
   * @param {string} mailPassword The password of the corresponding mail account.
   */
  async authenticateGithub(username, password, mailUsername, mailPassword) {
    if (this.page.mainFrame().url().startsWith('https://github.com/login')) {
      console.log('On Github login page. Trying to sign in.');
      await this.page.type('#login_field', username);
      await this.page.type('#password', password);
      await this.page.click('[name="commit"]');
      await this.page.waitForNetworkIdle().catch((err) => {
        console.error(
            'Waiting for network timeout not possible. Continue in hope that the page has changed',
            err,
        );
      });
    } else {
      console.log(
          'The current page is not a github login page. Continue without login',
          this.page.mainFrame().url(),
      );
    }

    if (
      this.page
          .mainFrame()
          .url()
          .startsWith('https://github.com/sessions/verified-device')
    ) {
      console.log('Need to verify the new device.');
      const mailbody = await this.getMailBySubject(
          mailUsername,
          mailPassword,
          '[GitHub] Please verify your device',
      );
      if (mailbody) {
        const regex = /Verification code: ([0-9]+)/g;
        const code = regex.exec(mailbody);
        if (!code) {
          throw new Error('No OTP code found in mail');
        }
        await this.page.type('#otp', code[1]);
        try {
          await (await this.page.$('#otp')).press('Enter');
        } catch (e) {
          console.error('Error entering OTP');
          console.error(e);
        }
        console.log('Waiting for page to finish loading');
        await this.page.waitForNetworkIdle().catch((err) => {
          console.error(
              'Waiting for network timeout not possible. Continue in hope that the page has changed',
              err,
          );
        });
      }
    } else {
      // Adding logs to see why certain things happened.
      console.log(
          'The current page is not a github verify device page. Continue without further verification',
          this.page.mainFrame().url(),
      );
    }
  }

  /**
   * Wait until the landing page was loaded successfully.
   */
  async waitForZenhubLandingPage() {
    try {
      await this.page.waitForSelector('.zhc-sidebar__navigation h1', {
        timeout: 120000,
      });
    } catch (e) {
      const bodyHTML = await this.page.evaluate(() => document.body.outerHTML);
      console.error(this.page.mainFrame().url());
      fs.writeFile('errorPageContent.html', bodyHTML, (err) => {
        console.error(err);
      });
      console.error(e);
    }
  }

  /**
   * Returns the unread mail with a given subject. Marks all mails as read.
    *
   * @param {string} mailUser the username of the mail account
   * @param {string} mailPassword the passowrd of the mail account
   * @param {string} expectedSubject the subject to look for.
   * @return {string} The mail body of the first unread mail with the given subject.
   */
  async getMailBySubject(mailUser, mailPassword, expectedSubject) {
    console.log('Retrieving mails to get the 2FA token');
    const config = {
      imap: {
        user: mailUser,
        password: mailPassword,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: {rejectUnauthorized: false},
        authTimeout: 3000,
      },
    };
    let body = undefined;
    await imaps.connect(config).then(function(connection) {
      try {
        return connection.openBox('INBOX').then(function() {
          const searchCriteria = ['UNSEEN'];
          const fetchOptions = {
            bodies: ['HEADER', 'TEXT'],
            markSeen: true,
          };
          return connection
              .search(searchCriteria, fetchOptions)
              .then(function(messages) {
                messages.forEach(function(item) {
                  const subject = item.parts.filter(function(part) {
                    return part.which === 'HEADER';
                  })[0].body.subject[0];
                  if (!body && subject == expectedSubject) {
                    body = item.parts.filter(function(part) {
                      return part.which === 'TEXT';
                    })[0].body;
                  }
                });
                connection.end();
              });
        });
      } catch (e) {
        try {
          connection.end();
        } catch (ex) {}
        console.error(e);
        throw e;
      }
    });
    return body;
  }
}

module.exports = ZenhubInofficialApiTokenCreator;
