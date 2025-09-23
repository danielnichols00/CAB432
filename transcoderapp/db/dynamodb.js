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

const qutUsername = process.env.QUT_USERNAME;
const tableName = "n11713739-videos"; // Use your actual table name

const client = new DynamoDBClient({ region: "ap-southeast-2" });
const docClient = DynamoDBDocumentClient.from(client);

// Add or update video metadata
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

// Get metadata for a specific video
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

// Query all videos for this user
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

// Update processed array for a video
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
