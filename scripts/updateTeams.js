const { Octokit } = require("octokit");
const fs = require("fs");
const path = require("path");

const parentTeamName = "Automatically managed";
var octokit = undefined;

var parentTeams = {};

async function main(teamsFolderPath, token) {
  octokit = new Octokit({
    auth: token,
  });
  var teams = parse(teamsFolderPath);
  console.log(teams);

  await removeOldTeams(teams);
  await createMissingTeams(teams);
  await ensureMembers(teams);
  await updateTeamRepos(teams);
}

function parse(teamsFolderPath) {
  var teams = [];
  var regex = /=+\s*(?<Name>.+)[\r\n]+(?<body>([^=].+[\r\n]+)*)/gm;
  fs.readdirSync(path.resolve(teamsFolderPath)).forEach((file) => {
    var content = fs.readFileSync(path.join(teamsFolderPath, file), {
      encoding: "utf-8",
    });
    var team = { members: [], repos: [] };
    var matches = content.matchAll(regex);
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
    teams.push(team);
  });
  return teams;
}

async function createMissingTeams(teams) {
  console.log("Creating missing teams");
  for (var i = 0; i < teams.length; i++) {
    await createMissingTeam(teams[i]);
  }
}

async function createMissingTeam(team) {
  var organisations = getOrganisationsFromTeam(team);
  for (var i = 0; i < organisations.length; i++) {
    console.log("Organisation: " + organisations[i]);
    if (!(await getParentTeamId(organisations[i]))) {
      console.log("Creating parent team");
      await octokit.request("POST /orgs/{org}/teams", {
        org: organisations[i],
        name: parentTeamName,
        description: "Managed by https://github.com/devonfw/organization",
        privacy: "closed",
      });
      await sleep(750);
    }
    if (!(await teamExisits(organisations[i], team.name))) {
      console.log("Creating team " + team.name);
      await octokit.request("POST /orgs/{org}/teams", {
        org: organisations[i],
        name: team.name,
        parent_team_id: await getParentTeamId(organisations[i]),
        privacy: "closed",
      });
      await sleep(750);
    }
  }
}

async function teamExisits(organisation, name) {
  var childteams = await getChildTeams(organisation);
  for (let i = 0; i < childteams.length; i++) {
    const team = childteams[i];
    if (team.name == name) {
      return true;
    }
  }
  return false;
}

function getOrganisationsFromTeam(team) {
  var organisations = [];
  for (var i = 0; i < team.repos.length; i++) {
    var split = team.repos[i].split("/");
    var org = split[0];
    if (!organisations.includes(org)) {
      organisations.push(org);
    }
  }
  return organisations;
}

async function removeOldTeams(teams) {
  console.log("Removing old teams");
  var organisations = await requestAll("GET /user/orgs", {});
  for (var i = 0; i < organisations.length; i++) {
    var childteams = getChildTeams(organisations[i].login);
    removeTeamsIfOld(teams, childteams, organisations[i].login);
  }
}

async function getChildTeams(organisation) {
  var parentTeamSlug = await getParentTeamSlug(organisation);
  if (parentTeamSlug) {
    var childteams = await requestAll(
      "GET /orgs/{org}/teams/{team_slug}/teams",
      {
        org: organisation,
        team_slug: parentTeamSlug,
      }
    );
    return childteams;
  }
  return [];
}

async function removeTeamsIfOld(teams, childteams, organisation) {
  for (var i = 0; i < childteams.length; i++) {
    removeTeamIfOld(teams, childteams[i], organisation);
  }
}

async function removeTeamIfOld(teams, childteam, organisation) {
  if (teamHasToBeDeleted(teams, childteam)) {
    console.log("Removing " + childteam.login);
    await octokit.request("DELETE /orgs/{org}/teams/{team_slug}", {
      org: organisation,
      team_slug: childteam.slug,
    });
    await sleep(750);
  }
}

async function getParentTeamSlug(organisation) {
  if (parentTeams[organisation]) {
    return parentTeams[organisation].slug;
  }
  try {
    var githubteams = await requestAll("GET /orgs/{org}/teams", {
      org: organisation,
    });
    for (var i = 0; i < githubteams.length; i++) {
      if (githubteams[i].name == parentTeamName) {
        parentTeams[organisation] = githubteams[i];
        return parentTeams[organisation].slug;
      }
    }
  } catch (e) {
    console.error(e);
  }
  return undefined;
}

async function getParentTeamId(organisation) {
  if (parentTeams[organisation]) {
    return parentTeams[organisation].id;
  }
  try {
    var githubteams = await requestAll("GET /orgs/{org}/teams", {
      org: organisation,
    });
    for (var i = 0; i < githubteams.length; i++) {
      if (githubteams[i].name == parentTeamName) {
        parentTeams[organisation] = githubteams[i];
        return parentTeams[organisation].id;
      }
    }
  } catch (e) {
    console.error(e);
  }
  return undefined;
}

function teamHasToBeDeleted(teams, childteam) {
  for (var i = 0; i < teams.length; i++) {
    if (teams[i].name == childteam.name) {
      return false;
    }
  }
  return true;
}

function getTeamSlugByName(childteams, name) {
  for (let i = 0; i < childteams.length; i++) {
    const team = childteams[i];
    if (team.name == name) {
      return team.slug;
    }
  }
  return undefined;
}

async function updateTeamMembers(team, organisation, teamSlug) {
  if (teamSlug) {
    console.log("Updating members of " + team.name);
    var members = await requestAll(
      "GET /orgs/{org}/teams/{team_slug}/members",
      {
        org: organisation,
        team_slug: teamSlug,
      }
    );
    await deleteOldUsers(members, team, organisation, teamSlug);
    await createUsers(team, organisation, teamSlug);
  }
}

async function createUsers(team, organisation, teamSlug) {
  for (let i = 0; i < team.members.length; i++) {
    const member = team.members[i];
    console.log("Ensuring that member is part of the team: " + member);
    await octokit.request(
      "PUT /orgs/{org}/teams/{team_slug}/memberships/{username}",
      {
        org: organisation,
        team_slug: teamSlug,
        username: member,
      }
    );
    await sleep(750);
  }
}

async function deleteOldUsers(members, team, organisation, teamSlug) {
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (!team.members.includes(member.login)) {
      console.log("Removing member from the team: " + member.login);
      await octokit.request(
        "DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}",
        {
          org: organisation,
          team_slug: teamSlug,
          username: member.login,
        }
      );
      await sleep(750);
    }
  }
}

async function ensureMembers(teams) {
  var childteams = {};
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    var organisations = getOrganisationsFromTeam(team);
    for (var j = 0; j < organisations.length; j++) {
      var organisation = organisations[j];
      if (!childteams[organisation]) {
        childteams[organisation] = await getChildTeams(organisation);
      }
      var teamSlug = getTeamSlugByName(childteams[organisation], team.name);
      await updateTeamMembers(team, organisation, teamSlug);
    }
  }
}

async function updateTeamRepos(teams) {
  console.log("Removing teams from old repos");
  var childteams = {};
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    var organisations = getOrganisationsFromTeam(team);
    for (var j = 0; j < organisations.length; j++) {
      var organisation = organisations[j];
      console.log("Organisation: " + organisation);
      if (!childteams[organisation]) {
        childteams[organisation] = await getChildTeams(organisation);
      }
      var teamSlug = getTeamSlugByName(childteams[organisation], team.name);
      await removeTeamFromOldRepos(team, organisation, teamSlug);
      await addTeamToRepos(team, organisation, teamSlug);
    }
  }
}

async function removeTeamFromOldRepos(team, organisation, teamSlug) {
  console.log("Removing team from old repos: " + team.name);
  var repos = await requestAll("GET /orgs/{org}/teams/{team_slug}/repos", {
    org: organisation,
    team_slug: teamSlug,
  });
  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    if (repoHasToBeRemoved(team, repo)) {
      console.log("Removing from " + repo.full_name);
      await octokit.request(
        "DELETE /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
        {
          org: organisation,
          team_slug: teamSlug,
          owner: repo.owner.login,
          repo: repo.name,
        }
      );
      await sleep(750);
    }
  }
}

function repoHasToBeRemoved(team, repo) {
  for (let i = 0; i < team.repos.length; i++) {
    const teamRepo = team.repos[i];
    if (teamRepo == repo.full_name || teamRepo == repo.owner.login) {
      return false;
    }
  }
  return true;
}

async function addTeamToRepos(team, organisation, teamSlug) {
  console.log("Ensuring rights of the team: " + team.name);
  for (let i = 0; i < team.repos.length; i++) {
    const teamRepo = team.repos[i];
    var split = teamRepo.split("/");
    if (split.length == 2) {
      await addTeamToRepo(organisation, teamSlug, split[0], split[1]);
    } else {
      await addTeamToOrg(organisation, teamSlug);
    }
  }
}

async function addTeamToOrg(organisation, teamSlug) {
  var repos = await requestAll("GET /orgs/{org}/repos", {
    org: organisation,
  });

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    await addTeamToRepo(organisation, teamSlug, repo.owner.login, repo.name);
  }
}

async function addTeamToRepo(organisation, teamSlug, owner, repo) {
  console.log("Ensuring rights of the team on: " + owner + "/" + repo);
  await octokit.request(
    "PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
    {
      org: organisation,
      team_slug: teamSlug,
      owner: owner,
      repo: repo,
      permission: "push",
    }
  );
  await sleep(750);
}

async function requestAll(request, parameters) {
  var result = [];
  parameters["per_page"] = "100";
  var page = 1;
  var response;
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