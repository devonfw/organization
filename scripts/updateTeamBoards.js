const { Octokit } = require("octokit");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const url = require("url");
const rp = require("request-promise-native");
const imaps = require("imap-simple");

const description = "Automatically managed";
const defaultRepoOrg = "devonfw";
const defaultRepoName = ".github";
const planningWorkspaceName = "Planning";

var octokit = undefined;
var gZenhubBffToken = undefined;
var gZenhubToken = undefined;
var repoCache = {};
var managedWorkspaces = {};

async function main(
  teamsFolderPath,
  boardsFolderPath,
  githubToken,
  zenhubToken,
  username,
  password,
  mailUser,
  mailPassword
) {
  octokit = new Octokit({
    auth: githubToken,
  });

  gZenhubToken = zenhubToken;

  gZenhubBffToken = await getToken(username, password, mailUser, mailPassword);
  return;

  await updateManagedWorkspaces();

  if (!workspaceExists(planningWorkspaceName)) {
    console.log("Creating planning workspace");
    await createWorkspace(planningWorkspaceName);
  }
  await updateManagedWorkspaces();
  await addAllReposToPlanningWorkspace();

  var teams = parse(teamsFolderPath);
  await createTeamWorkspaces(teams);

  await deleteOldWorkspaces(teams);
  await updateManagedWorkspaces();

  await updateWorkspaceRepos(teams);
  await updateLabelsOfWorkspaces(teams);
  await updatePipelines(boardsFolderPath, teams);
  await updatePipelinesOfPlanningWorkspace(boardsFolderPath, teams);

  await updatePipelineConnections(boardsFolderPath, teams);
}

async function updatePipelineConnections(boardsFolderPath, teams) {
  var { related, workspaces } = await getConnections();

  var resolvedConnections = resolveConnections(related, workspaces);
  var missingConnections = [];

  var planningPipelineDefinitions = loadPipelineDefinition(
    boardsFolderPath,
    "planning"
  );
  missingConnections = missingConnections.concat(
    ensureConnections(
      resolvedConnections,
      planningPipelineDefinitions,
      teams,
      planningWorkspaceName
    )
  );

  var teamPipelineDefinitions = loadPipelineDefinition(
    boardsFolderPath,
    "team"
  );
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    missingConnections = missingConnections.concat(
      ensureConnections(
        resolvedConnections,
        teamPipelineDefinitions,
        teams,
        team.name
      )
    );
  }
  for (let i = 0; i < resolvedConnections.length; i++) {
    const resolvedConnection = resolvedConnections[i];
    if (!resolvedConnection.found) {
      deleteConnection(resolvedConnection.id);
    }
  }

  for (let i = 0; i < missingConnections.length; i++) {
    const missingConnection = missingConnections[i];
    var sourceId = undefined;
    var destinationId = undefined;
    for (let j = 0; j < workspaces.length; j++) {
      const workspace = workspaces[j];
      if (
        workspace.name == missingConnection.sourceWorkspace ||
        workspace.name == missingConnection.destinationWorkspace
      ) {
        for (let k = 0; k < workspace.pipelines.length; k++) {
          const pipeline = workspace.pipelines[k];
          if (
            workspace.name == missingConnection.sourceWorkspace &&
            pipeline.name == missingConnection.sourcePipeline
          ) {
            sourceId = pipeline.id;
          } else if (
            workspace.name == missingConnection.destinationWorkspace &&
            pipeline.name == missingConnection.destinationPipeline
          ) {
            destinationId = pipeline.id;
          }
        }
      }
    }
    createConnection(sourceId, destinationId);
  }
}

async function deleteConnection(connectionId) {
  console.log("Delete connection: " + connectionId);
  await rp({
    uri: `https://api.zenhub.com/v1/graphql`,
    headers: {
      "x-authentication-token": gZenhubBffToken,
      "x-zenhub-agent": "webapp/3.3.19",
      "content-type": "application/json",
    },
    method: "POST",
    body:
      '[{"variables":{"input":{"pipelineToPipelineAutomationId":"' +
      connectionId +
      '"}},"query":"mutation ($input: DeletePipelineToPipelineAutomationInput!) {\\n  deletePipelineToPipelineAutomation(input: $input) {\\n    pipelineToPipelineAutomation {\\n      id\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}]',
  });
  await sleep(5000 * Math.random());
}

async function createConnection(sourcePipelineId, destinationPipelineId) {
  console.log(
    "Create connection: " + sourcePipelineId + "->" + destinationPipelineId
  );
  await rp({
    uri: `https://api.zenhub.com/v1/graphql`,
    headers: {
      "x-authentication-token": gZenhubBffToken,
      "x-zenhub-agent": "webapp/3.3.19",
      "content-type": "application/json",
    },
    method: "POST",
    body:
      '[{"variables":{"input":{"sourcePipelineId":"' +
      sourcePipelineId +
      '","destinationPipelineId":"' +
      destinationPipelineId +
      '","applyRetroactively":true}},"query":"mutation ($input: CreatePipelineToPipelineAutomationInput!) {\\n  createPipelineToPipelineAutomation(input: $input) {\\n    pipelineToPipelineAutomation {\\n      id\\n      sourcePipeline {\\n        id\\n        __typename\\n      }\\n      destinationPipeline {\\n        id\\n        __typename\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}]',
  });
  await sleep(5000 * Math.random());
}

function loadPipelineDefinition(boardsFolderPath, filename) {
  return JSON.parse(
    fs.readFileSync(
      path.join(path.resolve(boardsFolderPath), filename + ".json"),
      {
        encoding: "utf-8",
      }
    )
  );
}

function ensureConnections(connections, pipelineDefinitions, teams, name) {
  var missingConnections = [];
  for (let i = 0; i < pipelineDefinitions.pipelines.length; i++) {
    const pipeline = pipelineDefinitions.pipelines[i];
    if (pipeline.connections) {
      if (pipeline.isTeamPipeline) {
        for (let i = 0; i < teams.length; i++) {
          const team = teams[i];
          const replacement = team.name;
          missingConnections = missingConnections.concat(
            ensureConnection(connections, pipeline, name, replacement)
          );
        }
      } else {
        missingConnections = missingConnections.concat(
          ensureConnection(connections, pipeline, name, "")
        );
      }
    }
  }
  return missingConnections;
}

function ensureConnection(connections, pipeline, name, replacement) {
  var missingConnections = [];
  for (let j = 0; j < pipeline.connections.length; j++) {
    const connection = pipeline.connections[j];
    var foundConnection = findConnection(
      connections,
      name,
      pipeline.name.replace("<team name>", replacement),
      connection.board.replace("<team name>", replacement),
      connection.pipeline
    );
    if (foundConnection) {
      foundConnection.found = true;
    } else {
      missingConnections.push({
        sourceWorkspace: name,
        sourcePipeline: pipeline.name.replace("<team name>", replacement),
        destinationWorkspace: connection.board.replace(
          "<team name>",
          replacement
        ),
        destinationPipeline: connection.pipeline,
      });
    }
  }
  return missingConnections;
}

function findConnection(
  connections,
  sourceWorkspace,
  sourcePipeline,
  destinationWorkspace,
  destinationPipeline
) {
  for (let i = 0; i < connections.length; i++) {
    const connection = connections[i];
    if (
      connection.sourceWorkspace == sourceWorkspace &&
      connection.sourcePipeline == sourcePipeline &&
      connection.destinationWorkspace == destinationWorkspace &&
      connection.destinationPipeline
    ) {
      return connection;
    }
  }
  return null;
}

async function getConnections() {
  var planningWorkspaceId = managedWorkspaces[planningWorkspaceName].id;
  var related = await getRelated(planningWorkspaceId);
  var workspaces = [related];
  workspaces = workspaces.concat(related.relatedWorkspaces.nodes);
  return { related, workspaces };
}

function resolveConnections(related, workspaces) {
  var resolvedConnections = [];
  for (let i = 0; i < related.pipelineToPipelineAutomations.nodes.length; i++) {
    const connection = related.pipelineToPipelineAutomations.nodes[i];
    resolvedConnections.push(resolveConnection(workspaces, connection));
  }
  return resolvedConnections;
}

function resolveConnection(workspaces, connection) {
  var result = {
    sourceWorkspace: undefined,
    sourcePipeline: undefined,
    sourcePipelineId: undefined,
    destinationWorkspace: undefined,
    destinationPipeline: undefined,
    destinationPipelineId: undefined,
    id: connection.id,
    isIncomplete: false,
  };
  for (let i = 0; i < workspaces.length; i++) {
    const workspace = workspaces[i];
    for (let j = 0; j < workspace.pipelines.length; j++) {
      const pipeline = workspace.pipelines[j];
      if (pipeline.id == connection.sourcePipeline.id) {
        result.sourceWorkspace = workspace.name;
        result.sourcePipeline = pipeline.name;
        result.sourcePipelineId = connection.sourcePipeline.id;
      } else if (pipeline.id == connection.destinationPipeline.id) {
        result.destinationWorkspace = workspace.name;
        result.destinationPipeline = pipeline.name;
        result.destinationPipelineId = connection.destinationPipeline.id;
      }
    }
  }
  if (
    result.sourceWorkspace == undefined ||
    result.destinationWorkspace == undefined
  ) {
    result.isIncomplete = true;
  }
  return result;
}

async function getRelated(workspaceId) {
  var response = JSON.parse(
    await rp({
      uri: `https://api.zenhub.com/v1/graphql?query=[getRelated]`,
      headers: {
        "x-authentication-token": gZenhubBffToken,
        "x-zenhub-agent": "webapp/3.3.19",
        "content-type": "application/json",
      },
      method: "POST",
      body:
        '[{"operationName":"getRelated","variables":{"workspaceId":"' +
        workspaceId +
        '"},"query":"query getRelated($workspaceId: ID!) {\\n  workspace(id: $workspaceId) {\\n    id\\n    name\\n    description\\n    viewerPermission\\n    pipelines {\\n      id\\n      name\\n      __typename\\n    }\\n    relatedWorkspaces {\\n      nodes {\\n        id\\n        name\\n        description\\n        viewerPermission\\n        pipelines {\\n          id\\n          name\\n          __typename\\n        }\\n        pipelineToPipelineAutomations {\\n          nodes {\\n            id\\n            sourcePipeline {\\n              id\\n              __typename\\n            }\\n            destinationPipeline {\\n              id\\n              __typename\\n            }\\n            __typename\\n          }\\n          __typename\\n        }\\n        __typename\\n      }\\n      __typename\\n    }\\n    pipelineToPipelineAutomations {\\n      nodes {\\n        id\\n        sourcePipeline {\\n          id\\n          __typename\\n        }\\n        destinationPipeline {\\n          id\\n          __typename\\n        }\\n        __typename\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}]',
    })
  );
  await sleep(5000 * Math.random());
  return response[0].data.workspace;
}

async function deleteOldWorkspaces(teams) {
  console.log("Deleting old workspaces");
  for (const key in managedWorkspaces) {
    if (Object.hasOwnProperty.call(managedWorkspaces, key)) {
      const workspace = managedWorkspaces[key];
      if (
        workspace.name != planningWorkspaceName &&
        !teamExists(teams, workspace.name)
      ) {
        await deleteWorkspace(workspace.id);
      }
    }
  }
}

async function deleteWorkspace(workspaceId) {
  console.log("Removing: " + workspaceId);
  await rp({
    uri: `https://api.zenhub.com/v5/workspaces/${workspaceId}`,
    headers: {
      "x-authentication-token": gZenhubBffToken,
      "x-zenhub-agent": "webapp/3.3.19",
      "content-type": "application/json",
    },
    method: "DELETE",
    body: "",
  });
  await sleep(5000 * Math.random());
}

function teamExists(teams, name) {
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    if (team.name == name) {
      return true;
    }
  }
  return false;
}

async function createTeamWorkspaces(teams) {
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    if (!workspaceExists(team.name)) {
      console.log("Workspace does not exist: " + team.name);
      await createWorkspace(team.name);
    } else {
      console.log("Workspace exists: " + team.name);
    }
  }
}

async function updatePipelinesOfPlanningWorkspace(boardsFolderPath, teams) {
  var pipelineDefinitions = loadPipelineDefinition(
    boardsFolderPath,
    "planning"
  );

  var pipelines = [];
  for (let i = 0; i < pipelineDefinitions.pipelines.length; i++) {
    const pipeline = pipelineDefinitions.pipelines[i];
    if (pipeline.isTeamPipeline) {
      for (let j = 0; j < teams.length; j++) {
        const team = teams[j];
        pipelines.push({
          name: pipeline.name.replace("<team name>", team.name),
          description: pipeline.description.replace("<team name>", team.name),
        });
      }
    } else {
      pipelines.push(pipeline);
    }
  }
  pipelineDefinitions.pipelines = pipelines;

  console.log("Updating pipelines: " + planningWorkspaceName);
  await updateWorkspacePipelines(
    managedWorkspaces[planningWorkspaceName].id,
    pipelineDefinitions
  );
}

async function addAllReposToPlanningWorkspace() {
  var organisations = await requestAll("GET /user/orgs", {});
  for (var i = 0; i < organisations.length; i++) {
    var organisation = organisations[i];
    try {
      var repos = await requestAll("GET /orgs/{org}/repos", {
        org: organisation.login,
      });
      var repoIds = [];
      for (let i = 0; i < repos.length; i++) {
        const repo = repos[i];
        repoIds.push(repo.id);
      }
    } catch (e) {
      console.error(e);
    }
  }
  await addReposToWorkspace(
    managedWorkspaces[planningWorkspaceName].id,
    repoIds
  );
}

async function updatePipelines(boardsFolderPath, teams) {
  var pipelineDefinitions = loadPipelineDefinition(boardsFolderPath, "team");

  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    const workspaceId = managedWorkspaces[team.name].id;
    console.log("Updating pipelines: " + team.name);
    await updateWorkspacePipelines(workspaceId, pipelineDefinitions);
  }
}

async function updateWorkspacePipelines(workspaceId, pipelineDefinitions) {
  var pipelines = await getPipelinesOfWorkspace(workspaceId);
  await deleteEpicPipeline(pipelines);
  pipelines = await getPipelinesOfWorkspace(workspaceId);
  for (let j = 0; j < pipelineDefinitions.pipelines.length; j++) {
    const pipeline = pipelineDefinitions.pipelines[j];
    if (j < pipelines.length) {
      if (
        pipelines[j].name != pipeline.name ||
        pipelines[j].description != pipeline.description
      ) {
        await updatePipelinesOfWorkspace(
          pipelines[j].id,
          pipeline.name,
          pipeline.description
        );
      }
    } else {
      await createPipelineInWorkspace(
        workspaceId,
        pipeline.name,
        pipeline.description
      );
    }
  }
  for (
    let j = pipelineDefinitions.pipelines.length;
    j < pipelines.length;
    j++
  ) {
    const pipeline = pipelines[j];
    await deletePipelineInWorkspace(pipeline.id, pipelines[0].id);
  }
}

async function deleteEpicPipeline(pipelines) {
  for (let j = 0; j < pipelines.length; j++) {
    const pipeline = pipelines[j];
    if (pipeline.isEpicPipeline) {
      await deletePipelineInWorkspace(pipeline.id, pipelines[0].id);
    }
  }
}

async function getPipelinesOfWorkspace(workspaceId) {
  var response = JSON.parse(
    await rp({
      uri: `https://api.zenhub.com/v1/graphql?query=[workspacePipelines]`,
      headers: {
        "x-authentication-token": gZenhubBffToken,
        "x-zenhub-agent": "webapp/3.3.19",
        "content-type": "application/json",
      },
      method: "POST",
      body:
        '[{"operationName":"workspacePipelines","variables":{"workspaceId":"' +
        workspaceId +
        '"},"query":"query workspacePipelines($workspaceId: ID!) {\\n  workspace(id: $workspaceId) {\\n    id\\n    prioritiesConnection {\\n      nodes {\\n        ...boardPriorityData\\n        __typename\\n      }\\n      __typename\\n    }\\n    pipelinesConnection {\\n      nodes {\\n        ...boardPipelineData\\n        __typename\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n\\nfragment boardPriorityData on Priority {\\n  id\\n  name\\n  color\\n  __typename\\n}\\n\\nfragment boardPipelineData on Pipeline {\\n  id\\n  name\\n  description\\n  isEpicPipeline\\n  workspace {\\n    id\\n    __typename\\n  }\\n  __typename\\n}\\n"}]',
    })
  );
  await sleep(5000 * Math.random());
  return response[0].data.workspace.pipelinesConnection.nodes;
}

async function updatePipelinesOfWorkspace(pipelineId, name, description) {
  console.log("Changing pipeline: " + name + " -> " + description);
  await rp({
    uri: `https://api.zenhub.com/v1/graphql?query=pipelineUpdate`,
    headers: {
      "x-authentication-token": gZenhubBffToken,
      "x-zenhub-agent": "webapp/3.3.19",
      "content-type": "application/json",
    },
    method: "POST",
    body:
      '[{"operationName":"pipelineUpdate","variables":{"input":{"pipelineId":"' +
      pipelineId +
      '","name":"' +
      name +
      '","description":"' +
      description +
      '"}},"query":"mutation pipelineUpdate($input: UpdatePipelineInput!) {\\n  updatePipeline(input: $input) {\\n    pipeline {\\n      ...boardPipelineData\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n\\nfragment boardPipelineData on Pipeline {\\n  id\\n  name\\n  description\\n  isEpicPipeline\\n  workspace {\\n    id\\n    __typename\\n  }\\n  __typename\\n}\\n"}]',
  });
  await sleep(5000 * Math.random());
}

async function createPipelineInWorkspace(workspaceId, name, description) {
  console.log("Creating pipeline: " + name + " -> " + description);
  await rp({
    uri: `https://api.zenhub.com/v1/graphql?query=pipelineUpdate`,
    headers: {
      "x-authentication-token": gZenhubBffToken,
      "x-zenhub-agent": "webapp/3.3.19",
      "content-type": "application/json",
    },
    method: "POST",
    body:
      '[{"operationName":"pipelineCreate","variables":{"input":{"workspaceId":"' +
      workspaceId +
      '","name":"' +
      name +
      '","description":"' +
      description +
      '"}},"query":"mutation pipelineCreate($input: CreatePipelineInput!) {\\n  createPipeline(input: $input) {\\n    pipeline {\\n      ...boardPipelineData\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n\\nfragment boardPipelineData on Pipeline {\\n  id\\n  name\\n  description\\n  isEpicPipeline\\n  workspace {\\n    id\\n    __typename\\n  }\\n  __typename\\n}\\n"}]',
  });
  await sleep(5000 * Math.random());
}

async function deletePipelineInWorkspace(pipelineId, destinationPipelineId) {
  console.log("Deleting pipeline: " + pipelineId);
  await rp({
    uri: `https://api.zenhub.com/v1/graphql?query=pipelineDelete`,
    headers: {
      "x-authentication-token": gZenhubBffToken,
      "x-zenhub-agent": "webapp/3.3.19",
      "content-type": "application/json",
    },
    method: "POST",
    body:
      '[{"operationName":"pipelineDelete","variables":{"input":{"pipelineId":"' +
      pipelineId +
      '","destinationPipelineId":"' +
      destinationPipelineId +
      '"}},"query":"mutation pipelineDelete($input: DeletePipelineInput!) {\\n  deletePipeline(input: $input) {\\n    destinationPipeline {\\n      ...boardPipelineData\\n      __typename\\n    }\\n    eventId\\n    __typename\\n  }\\n}\\n\\nfragment boardPipelineData on Pipeline {\\n  id\\n  name\\n  description\\n  isEpicPipeline\\n  workspace {\\n    id\\n    __typename\\n  }\\n  __typename\\n}\\n"}]',
  });
  await sleep(5000 * Math.random());
}

async function updateLabelsOfWorkspaces(teams) {
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    await updateLabelOfWorkspace(managedWorkspaces[team.name].id, team);
  }
}

async function updateWorkspaceRepos(teams) {
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    console.log(team.name);
    var teamRepoIds = await getRepoIdsOfTeam(team);
    teamRepoIds.push((await getRepoByName(defaultRepoOrg, defaultRepoName)).id);
    var workspace = managedWorkspaces[team.name];
    var reposToAdd = teamRepoIds.filter(
      (r) => !workspace.repositories.includes(r)
    );
    var reposToRemove = workspace.repositories.filter(
      (r) => !teamRepoIds.includes(r)
    );
    await addReposToWorkspace(workspace.id, reposToAdd);
    await removeReposFromWorkspace(workspace.id, reposToRemove);
  }
}

async function getRepoIdsOfTeam(team) {
  var teamRepoIds = [];
  for (let i = 0; i < team.repos.length; i++) {
    const repo = team.repos[i];
    var split = repo.split("/");
    if (split.length == 2) {
      teamRepoIds.push((await getRepoByName(split[0], split[1])).id);
    } else {
      teamRepoIds = teamRepoIds.concat(await getRepoIdsOfOrg(split[0]));
    }
  }
  return teamRepoIds;
}

async function getRepoIdsOfOrg(org) {
  var repoIds = [];
  var repos = await requestAll("GET /orgs/{org}/repos", {
    org: org,
  });

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    repoIds.push(repo.id);
    repoCache[repo.full_name] = repo;
  }
  return repoIds;
}

async function createWorkspace(name) {
  var defaultRepo = await getRepoByName(defaultRepoOrg, defaultRepoName);

  await rp({
    uri: `https://api.zenhub.com/v1/graphql`,
    headers: {
      "x-authentication-token": gZenhubBffToken,
      "x-zenhub-agent": "webapp/3.3.19",
      "content-type": "application/json",
    },
    method: "POST",
    body:
      '[{"variables":{"input":{"defaultRepositoryGhId":' +
      defaultRepo.id +
      ',"description":"' +
      description +
      '","name":"' +
      name +
      '","repositoryGhIds":[' +
      defaultRepo.id +
      ']}},"query":"mutation ($input: CreateWorkspaceInput!) {\\n  createWorkspace(input: $input) {\\n    workspace {\\n      ...workspaceData\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n\\nfragment workspaceData on Workspace {\\n  id\\n  name\\n  defaultRepository {\\n    id\\n    ghId\\n    name\\n    owner {\\n      id\\n      login\\n      __typename\\n    }\\n    __typename\\n  }\\n  repositoriesConnection {\\n    nodes {\\n      ...repoData\\n      __typename\\n    }\\n    __typename\\n  }\\n  __typename\\n}\\n\\nfragment repoData on Repository {\\n  ghId\\n  name\\n  description\\n  owner {\\n    id\\n    login\\n    __typename\\n  }\\n  permissions {\\n    push\\n    pull\\n    admin\\n    __typename\\n  }\\n  issues {\\n    totalCount\\n    __typename\\n  }\\n  isPrivate\\n  __typename\\n}\\n"}]',
  });
  await sleep(5000 * Math.random());
}

async function updateLabelOfWorkspace(workspaceId, team) {
  console.log("Adding label to workspace: " + team.name);
  await rp({
    uri: `https://api.zenhub.com/v1/graphql?query=[addWorkspaceLabelFilters]`,
    headers: {
      "x-authentication-token": gZenhubBffToken,
      "x-zenhub-agent": "webapp/3.3.19",
      "content-type": "application/json",
    },
    method: "POST",
    body:
      '[{"operationName":"addWorkspaceLabelFilters","variables":{"input":{"workspaceId":"' +
      workspaceId +
      '","labelNames":["' +
      getLabelName(team) +
      '"]}},"query":"mutation addWorkspaceLabelFilters($input: AddWorkspaceLabelFiltersInput!) {\\n  addWorkspaceLabelFilters(input: $input) {\\n    workspace {\\n      id\\n      labelFilters {\\n        nodes {\\n          id\\n          labelName\\n          __typename\\n        }\\n        __typename\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}]',
  });
  await sleep(5000 * Math.random());
}

function getLabelName(team) {
  return "Team_" + team.name.replace(/[^A-Za-z0-9]/, "_");
}

async function removeReposFromWorkspace(workspaceId, repoIds) {
  console.log("Removing repos to workspace: " + workspaceId);
  for (let i = 0; i < repoIds.length; i++) {
    const repoId = repoIds[i];
    await removeRepoFromWorkspace(workspaceId, repoId);
  }
}

async function removeRepoFromWorkspace(workspaceId, repoId) {
  console.log("Removing: " + repoId);
  await rp({
    uri: `https://api.zenhub.com/v5/workspaces/${workspaceId}/disconnect/repositories/${repoId}`,
    headers: {
      "x-authentication-token": gZenhubBffToken,
      "x-zenhub-agent": "webapp/3.3.19",
      "content-type": "application/json",
    },
    method: "DELETE",
    body: '{"split":false}',
  });
  await sleep(5000 * Math.random());
}

async function addReposToWorkspace(workspaceId, repoIds) {
  console.log("Adding repos to workspace: " + workspaceId);
  for (let i = 0; i < repoIds.length; i++) {
    const repoId = repoIds[i];
    await addRepoToWorkspace(workspaceId, repoId);
  }
}

async function addRepoToWorkspace(workspaceId, repoId) {
  console.log("Adding: " + repoId);
  await rp({
    uri: `https://api.zenhub.com/v1/graphql`,
    headers: {
      "x-authentication-token": gZenhubBffToken,
      "x-zenhub-agent": "webapp/3.3.19",
      "content-type": "application/json",
    },
    method: "POST",
    body:
      '[{"variables":{"input":{"repositoryGhId":' +
      repoId +
      ',"workspaceId":"' +
      workspaceId +
      '"}},"query":"mutation ($input: AddRepositoryToWorkspaceInput!) {\\n  addRepositoryToWorkspace(input: $input) {\\n    workspaceRepository {\\n      id\\n      repository {\\n        ghId\\n        name\\n        description\\n        owner {\\n          id\\n          login\\n          __typename\\n        }\\n        permissions {\\n          push\\n          pull\\n          admin\\n          __typename\\n        }\\n        issues {\\n          totalCount\\n          __typename\\n        }\\n        isPrivate\\n        __typename\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}]',
  });
  await sleep(5000 * Math.random());
}

async function getRepoByName(org, name) {
  if (!repoCache[org + "/" + name]) {
    var response = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: org,
      repo: name,
    });

    repoCache[org + "/" + name] = response.data;
  }

  return repoCache[org + "/" + name];
}

async function updateManagedWorkspaces() {
  managedWorkspaces = {};
  var defaultRepo = await getRepoByName(defaultRepoOrg, defaultRepoName);
  var response = JSON.parse(
    await rp({
      uri: `https://api.zenhub.com/p2/repositories/${defaultRepo.id}/workspaces`,
      headers: {
        "X-Authentication-Token": gZenhubToken,
      },
    })
  );
  await sleep(5000 * Math.random());
  for (let i = 0; i < response.length; i++) {
    const workspace = response[i];
    if (workspace.description == description) {
      managedWorkspaces[workspace.name] = workspace;
    }
  }
}

function workspaceExists(name) {
  return !!managedWorkspaces[name];
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

async function getToken(username, password, mailUsername, mailPassword) {
  console.log(username);
  var token = undefined;
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  try {
    if (!fs.existsSync(path.resolve("./cookies"))) {
      fs.mkdirSync(path.resolve("./cookies"));
    }

    await goto(page, "https://github.com/login");
    await page.waitForNetworkIdle();
    if (page.mainFrame().url() == "https://github.com/login") {
      await page.type("#login_field", username);
      await page.type("#password", password);
      await page.click('[name="commit"]');
      await page.waitForNetworkIdle();
    }

    if (
      page.mainFrame().url() == "https://github.com/sessions/verified-device"
    ) {
      console.error("github verify device page");
      console.log(await page.mainFrame().content());
      var mailbody = await getMailBySubject(
        mailUsername,
        mailPassword,
        "[GitHub] Please verify your device"
      );
      if (mailbody) {
        var regex = /Verification code: ([0-9]+)/g;
        var code = regex.exec(mailbody);
        console.log(code[1]);
        await page.type("#otp", code[1]);
        await page.click('.btn-primary');
        await page.waitForNetworkIdle();
      }
      process.exit(-1);
    }
    await goto(page, "https://app.zenhub.com");
    await page.waitForNetworkIdle();
    await saveCookies(page);

    if (page.mainFrame().url() == "https://app.zenhub.com/login") {
      console.log("Zenhub login page");
      await page.waitForSelector(".zhc-button--color-primary");
      await (await page.$(".zhc-button--color-primary")).click();
      await page.waitForSelector(".zhc-sidebar__navigation h1");
    } else {
      console.error("Zenhub login page expected");
    }

    const localStorage = await page.evaluate(() =>
      Object.assign({}, window.localStorage)
    );
    token = localStorage.api_token;
  } catch (e) {
    console.error(e);
  }

  await browser.close();
  return token;
}

async function goto(page, targetUrl) {
  var currentDomain = await saveCookies(page);

  var domain = url.parse(targetUrl).hostname;
  if (
    domain != currentDomain &&
    fs.existsSync(path.resolve("./cookies/" + domain + ".json"))
  ) {
    const cookiesString = fs.readFileSync(
      path.resolve("./cookies/" + domain + ".json")
    );
    const cookies = JSON.parse(cookiesString);
    await page.setCookie(...cookies);
  }

  await page.goto(targetUrl);
}

async function saveCookies(page) {
  var currentDomain = url.parse(page.mainFrame().url()).hostname;
  const currentCookies = await page.cookies();
  fs.writeFileSync(
    path.resolve("./cookies/" + currentDomain + ".json"),
    JSON.stringify(currentCookies, null, 2)
  );
  return currentDomain;
}

async function getMailBySubject(mailUser, mailPassword, expectedSubject) {
  var config = {
    imap: {
      user: mailUser,
      password: mailPassword,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 3000,
    },
  };
  var body = undefined;
  await imaps.connect(config).then(function (connection) {
    try {
      return connection.openBox("INBOX").then(function () {
        var searchCriteria = ["UNSEEN"];
        var fetchOptions = {
          bodies: ["HEADER", "TEXT"],
          markSeen: true,
        };
        return connection
          .search(searchCriteria, fetchOptions)
          .then(function (messages) {
            messages.forEach(function (item) {
              var subject = item.parts.filter(function (part) {
                return part.which === "HEADER";
              })[0].body.subject[0];
              if (!body && subject == expectedSubject) {
                body = item.parts.filter(function (part) {
                  return part.which === "TEXT";
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

async function requestAll(request, parameters) {
  var result = [];
  parameters["per_page"] = "100";
  var page = 1;
  var response;
  do {
    parameters["page"] = page++;
    response = await octokit.request(request, parameters);
    result = result.concat(response.data);
  } while (response && response.body && response.body.length > 0);

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main(
  process.argv[2],
  process.argv[3],
  process.argv[4],
  process.argv[5],
  process.argv[6],
  process.argv[7],
  process.argv[8],
  process.argv[9]
).catch((e) => {
  console.error(e);
  process.exit(-1);
});
