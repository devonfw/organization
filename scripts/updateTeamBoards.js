const { Octokit } = require("octokit");
const fs = require("fs");
const path = require("path");
const rp = require("request-promise-native");

const ZenhubInofficialApiTokenCreator = require('./zenhubInofficialAPITokenCreator');

const description = "Automatically managed";
const defaultRepoOrg = "devonfw";
const defaultRepoName = ".github";
const planningWorkspaceName = "Planning";

let octokit = undefined;
let gZenhubBffToken = undefined;
let gZenhubToken = undefined;
const repoCache = {};
let managedWorkspaces = {};

async function main(
  teamsFolderPath,
  boardsFolderPath,
  githubToken,
  zenhubToken,
  username,
  password,
  mailUser,
  mailPassword,
) {
  octokit = new Octokit({
    auth: githubToken,
  });

  gZenhubToken = zenhubToken;

  const zenhubTokenCreator = new ZenhubInofficialApiTokenCreator();

  gZenhubBffToken = await zenhubTokenCreator.getToken(
      username,
      password,
      mailUser,
      mailPassword
  );

  await updateManagedWorkspaces();

  if (!workspaceExists(planningWorkspaceName)) {
    console.log("Creating planning workspace");
    await createWorkspace(planningWorkspaceName);
  }
  await updateManagedWorkspaces();
  await addAllReposToPlanningWorkspace();

  const teams = parse(teamsFolderPath);
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
  const {related, workspaces} = await getConnections();

  const resolvedConnections = resolveConnections(related, workspaces);
  let missingConnections = [];

  const planningPipelineDefinitions = loadPipelineDefinition(
      boardsFolderPath,
      "planning"
  );
  missingConnections = missingConnections.concat(
    ensureConnections(
      resolvedConnections,
      planningPipelineDefinitions,
      teams,
      planningWorkspaceName,
    ),
  );

  const teamPipelineDefinitions = loadPipelineDefinition(
      boardsFolderPath,
      'team'
  );
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    missingConnections = missingConnections.concat(
      ensureConnections(
        resolvedConnections,
        teamPipelineDefinitions,
        teams,
        team.name
      ),
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
    let sourceId = undefined;
    let destinationId = undefined;
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
      },
      )
  );
}

function ensureConnections(connections, pipelineDefinitions, teams, name) {
  let missingConnections = [];
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
  const missingConnections = [];
  for (let j = 0; j < pipeline.connections.length; j++) {
    const connection = pipeline.connections[j];
    const foundConnection = findConnection(
        connections,
        name,
        pipeline.name.replace('<team name>', replacement),
        connection.board.replace('<team name>', replacement),
        connection.pipeline,
    );
    if (foundConnection) {
      foundConnection.found = true;
    } else {
      missingConnections.push({
        sourceWorkspace: name,
        sourcePipeline: pipeline.name.replace("<team name>", replacement),
        destinationWorkspace: connection.board.replace(
          "<team name>",
          replacement,
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
  destinationPipeline,
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
  const planningWorkspaceId = managedWorkspaces[planningWorkspaceName].id;
  const related = await getRelated(planningWorkspaceId);
  let workspaces = [related];
  workspaces = workspaces.concat(related.relatedWorkspaces.nodes);
  return { related, workspaces };
}

function resolveConnections(related, workspaces) {
  const resolvedConnections = [];
  for (let i = 0; i < related.pipelineToPipelineAutomations.nodes.length; i++) {
    const connection = related.pipelineToPipelineAutomations.nodes[i];
    resolvedConnections.push(resolveConnection(workspaces, connection));
  }
  return resolvedConnections;
}

function resolveConnection(workspaces, connection) {
  const result = {
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
  const response = JSON.parse(
      await rp({
        uri: `https://api.zenhub.com/v1/graphql?query=[getRelated]`,
        headers: {
          'x-authentication-token': gZenhubBffToken,
          "x-zenhub-agent": 'webapp/3.3.19',
          "content-type": 'application/json',
        },
        method: 'POST',
        body:
        '[{"operationName":"getRelated","variables":{"workspaceId":"' +
        workspaceId +
        '"},"query":"query getRelated($workspaceId: ID!) {\\n  workspace(id: $workspaceId) {\\n    id\\n    name\\n    description\\n    viewerPermission\\n    pipelines {\\n      id\\n      name\\n      __typename\\n    }\\n    relatedWorkspaces {\\n      nodes {\\n        id\\n        name\\n        description\\n        viewerPermission\\n        pipelines {\\n          id\\n          name\\n          __typename\\n        }\\n        pipelineToPipelineAutomations {\\n          nodes {\\n            id\\n            sourcePipeline {\\n              id\\n              __typename\\n            }\\n            destinationPipeline {\\n              id\\n              __typename\\n            }\\n            __typename\\n          }\\n          __typename\\n        }\\n        __typename\\n      }\\n      __typename\\n    }\\n    pipelineToPipelineAutomations {\\n      nodes {\\n        id\\n        sourcePipeline {\\n          id\\n          __typename\\n        }\\n        destinationPipeline {\\n          id\\n          __typename\\n        }\\n        __typename\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}]',
      }),
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
  const pipelineDefinitions = loadPipelineDefinition(
      boardsFolderPath,
      'planning'
  );

  const pipelines = [];
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
  const organisations = await requestAll('GET /user/orgs', {});
  const repoIds = [];
  for (let i = 0; i < organisations.length; i++) {
    const organisation = organisations[i];
    console.log("Org: " + organisation.login);
    try {
      const repos = await requestAll('GET /orgs/{org}/repos', {
        org: organisation.login,
      });
      for (let i = 0; i < repos.length; i++) {
        const repo = repos[i];
        console.log("Repo: " + repo.full_name);
        repoIds.push(repo.id);
      }
    } catch (e) {
      console.error(e);
    }
  }
  await addReposToWorkspace(
    managedWorkspaces[planningWorkspaceName].id,
    repoIds,
  );
}

async function updatePipelines(boardsFolderPath, teams) {
  const pipelineDefinitions = loadPipelineDefinition(boardsFolderPath, 'team');

  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    const workspaceId = managedWorkspaces[team.name].id;
    console.log("Updating pipelines: " + team.name);
    await updateWorkspacePipelines(workspaceId, pipelineDefinitions);
  }
}

async function updateWorkspacePipelines(workspaceId, pipelineDefinitions) {
  let pipelines = await getPipelinesOfWorkspace(workspaceId);
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
  const response = JSON.parse(
      await rp({
        uri: `https://api.zenhub.com/v1/graphql?query=[workspacePipelines]`,
        headers: {
          "x-authentication-token": gZenhubBffToken,
          "x-zenhub-agent": 'webapp/3.3.19',
          "content-type": 'application/json',
        },
        method: 'POST',
        body:
        '[{"operationName":"workspacePipelines","variables":{"workspaceId":"' +
        workspaceId +
        '"},"query":"query workspacePipelines($workspaceId: ID!) {\\n  workspace(id: $workspaceId) {\\n    id\\n    prioritiesConnection {\\n      nodes {\\n        ...boardPriorityData\\n        __typename\\n      }\\n      __typename\\n    }\\n    pipelinesConnection {\\n      nodes {\\n        ...boardPipelineData\\n        __typename\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n\\nfragment boardPriorityData on Priority {\\n  id\\n  name\\n  color\\n  __typename\\n}\\n\\nfragment boardPipelineData on Pipeline {\\n  id\\n  name\\n  description\\n  isEpicPipeline\\n  workspace {\\n    id\\n    __typename\\n  }\\n  __typename\\n}\\n"}]',
      }),
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
    const reposToAdd = teamRepoIds.filter(
        (r) => !workspace.repositories.includes(r),
    );
    const reposToRemove = workspace.repositories.filter(
        (r) => !teamRepoIds.includes(r),
    );
    await addReposToWorkspace(workspace.id, reposToAdd);
    await removeReposFromWorkspace(workspace.id, reposToRemove);
  }
}

async function getRepoIdsOfTeam(team) {
  let teamRepoIds = [];
  for (let i = 0; i < team.repos.length; i++) {
    const repo = team.repos[i];
    const split = repo.split('/');
    if (split.length == 2) {
      teamRepoIds.push((await getRepoByName(split[0], split[1])).id);
    } else {
      teamRepoIds = teamRepoIds.concat(await getRepoIdsOfOrg(split[0]));
    }
  }
  return teamRepoIds;
}

async function getRepoIdsOfOrg(org) {
  const repoIds = [];
  const repos = await requestAll('GET /orgs/{org}/repos', {
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
  const defaultRepo = await getRepoByName(defaultRepoOrg, defaultRepoName);

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
    const response = await octokit.request('GET /repos/{owner}/{repo}', {
      owner: org,
      repo: name,
    });

    repoCache[org + "/" + name] = response.data;
  }

  return repoCache[org + "/" + name];
}

async function updateManagedWorkspaces() {
  managedWorkspaces = {};
  const defaultRepo = await getRepoByName(defaultRepoOrg, defaultRepoName);
  const response = JSON.parse(
      await rp({
        uri: `https://api.zenhub.com/p2/repositories/${defaultRepo.id}/workspaces`,
        headers: {
          "X-Authentication-Token": gZenhubToken,
        },
      }),
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
    teams.push(team);
  });
  return teams;
}

async function requestAll(request, parameters) {
  let result = [];
  parameters["per_page"] = "100";
  let page = 1;
  let response;
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
