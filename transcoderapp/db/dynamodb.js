require("dotenv").config();
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const { getParameter } = require("../config/parameterStore");

const qutUsername = process.env.QUT_USERNAME;
let tableName, region;
let client, docClient;

async function initDynamo() {
  tableName = await getParameter("/n11713739/dynamotable");
  region = await getParameter("/n11713739/aws_region");
  client = new DynamoDBClient({ region: region || "ap-southeast-2" });
  docClient = DynamoDBDocumentClient.from(client);
}

initDynamo();

// ADD AND UPDATE VIDEO METADATA
async function putVideoMetadata(filename, processed = [], owner = qutUsername) {
  const command = new PutCommand({
    TableName: tableName,
    Item: {
      "qut-username": owner,
      filename,
      processed,
      uploadedAt: new Date().toISOString(),
    },
  });
  return await docClient.send(command);
}

// GET METADATA FOR A VIDEO
async function getVideoMetadata(filename, owner = qutUsername) {
  const command = new GetCommand({
    TableName: tableName,
    Key: {
      "qut-username": owner,
      filename,
    },
  });
  const result = await docClient.send(command);
  return result.Item;
}

async function scanAllVideos() {
  const command = new ScanCommand({ TableName: tableName });
  const result = await docClient.send(command);
  return result.Items || [];
}

// QUERY ALL VIDEOS FOR USER
async function queryAllVideos(owner = qutUsername) {
  if (owner === "*") {
    const result = await docClient.send(
      new ScanCommand({ TableName: tableName })
    );
    return result.Items || [];
  }
  const command = new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "#pk = :owner",
    ExpressionAttributeNames: { "#pk": "qut-username" },
    ExpressionAttributeValues: { ":owner": owner },
  });
  const result = await docClient.send(command);
  return result.Items || [];
}

// UPDATE VIDEO ARRAY
async function updateProcessed(filename, processed, owner = qutUsername) {
  const command = new UpdateCommand({
    TableName: tableName,
    Key: {
      "qut-username": owner,
      filename,
    },
    UpdateExpression: "SET processed = :processed, lastTranscodedAt = :ts",
    ExpressionAttributeValues: {
      ":processed": processed,
      ":ts": new Date().toISOString(),
    },
    ReturnValues: "ALL_NEW",
  });
  return await docClient.send(command);
}

module.exports = {
  putVideoMetadata,
  getVideoMetadata,
  queryAllVideos,
  updateProcessed,
  scanAllVideos,
};
