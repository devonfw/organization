const { Octokit } = require("octokit");
const fs = require("fs");
const path = require("path");

const labelColor = "010101";
const defaultRepo = "devonfw/.github";
let octokit = undefined;

async function main(teamsFolderPath, token) {
  octokit = new Octokit({
    auth: token,
  });
  const teams = [];
  const regex = /=+\s*(?<Name>.+)[\r\n]+(?<body>([^=].+[\r\n]+)*)/gm;
  fs.readdirSync(path.resolve(teamsFolderPath)).forEach((file) => {
    const content = fs.readFileSync(path.join(teamsFolderPath, file), {
      encoding: 'utf-8',
    });
    const team = {members: [], repos: []};
    const matches = content.matchAll(regex);
    for (const match of matches) {
      if (!match[0].startsWith("==")) {
        team.name = match[1];
      } else if (match[1] == "Members") {
        for (const line of match[2].matchAll(/\s*\*\s*(.+)/g)) {
          team.members.push(line[1]);
        }
      } else if (match[1] == "Repos") {
        for (const line of match[2].matchAll(/\s*\*\s*(.+)/g)) {
          team.repos.push(line[1]);
        }
      }
    }
    team.repos.push(defaultRepo);
    teams.push(team);
  });
  console.log(teams);

  await removeOldLabels(teams);
  await createLabels(teams);
}

async function createLabels(teams) {
  console.log("Creating labels");
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    await createLabelForTeam(team);
  }
}

async function createLabelForTeam(team) {
  console.log("Creating labels for: " + team.name);
  for (let i = 0; i < team.repos.length; i++) {
    const repo = team.repos[i];
    const split = repo.split('/');
    if (split.length == 2) {
      await createLabelForTeamInRepo(team, split[0], split[1]);
    } else {
      await createLabelForTeamInOrg(team, repo);
    }
  }
}

async function createLabelForTeamInOrg(team, organisation) {
  console.log("Creating labels in org: " + organisation);
  const repos = await requestAll('GET /orgs/{org}/repos', {
    org: organisation,
  });

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    await createLabelForTeamInRepo(team, repo.owner.login, repo.name);
  }
}

async function createLabelForTeamInRepo(team, owner, repo) {
  let request = "POST /repos/{owner}/{repo}/labels";
  try {
    await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
      owner: owner,
      repo: repo,
      name: getLabelName(team),
    });
    await sleep(750);
    request = "PATCH /repos/{owner}/{repo}/labels/{name}";
  } catch (e) {}

  try {
    console.log("Creating/updating label in: " + owner + "/" + repo);
    await octokit.request(request, {
      owner: owner,
      repo: repo,
      name: getLabelName(team),
      color: labelColor,
      description: "These issues will be handeled by the team " + team.name,
    });
    await sleep(750);
  } catch (e) {
    console.error(e);
  }
}

async function removeOldLabels(teams) {
  console.log("Removing old labels");
  const organisations = await requestAll('GET /user/orgs', {});
  for (let i = 0; i < organisations.length; i++) {
    const organisation = organisations[i];
    await removeOldLabelsFromOrg(teams, organisation.login);
  }
}

async function removeOldLabelsFromOrg(teams, organisation) {
  console.log("Removing old labels from organisation: " + organisation);
  try {
    const repos = await requestAll('GET /orgs/{org}/repos', {
      org: organisation,
    });
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i];
      await removeOldLabelsFromRepo(teams, organisation, repo.name);
    }
  } catch (e) {
    console.log(e);
  }
}

async function removeOldLabelsFromRepo(teams, owner, repo) {
  console.log("Removing old labels from repo: " + owner + "/" + repo);
  const labels = await requestAll('GET /repos/{owner}/{repo}/labels', {
    owner: owner,
    repo: repo,
  });
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (labelHasToBeRemoved(teams, label)) {
      console.log("Removing old label: " + label.name);
      await octokit.request("DELETE /repos/{owner}/{repo}/labels/{name}", {
        owner: owner,
        repo: repo,
        name: label.name,
      });
      await sleep(750);
    }
  }
}

function labelHasToBeRemoved(teams, label) {
  if (label.color != labelColor) {
    return false;
  }
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    if (label.name == getLabelName(team)) {
      return false;
    }
  }
  return true;
}

function getLabelName(team) {
  return "Team_" + team.name.replace(/[^A-Za-z0-9]/, "_");
}

async function requestAll(request, parameters) {
  let result = [];
  parameters["per_page"] = "100";
  let page = 1;
  let response;
  do {
    parameters["page"] = page++;
    response = await octokit.request(request, parameters);
    await sleep(750);
    result = result.concat(response.data);
  } while (response && response.body && response.body.length > 0);

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main(process.argv[2], process.argv[3]).catch((e) => {
  console.error(e);
  process.exit(-1);
});
