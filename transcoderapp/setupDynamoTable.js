require("dotenv").config();
const { DynamoDBClient, CreateTableCommand } = require("@aws-sdk/client-dynamodb");

const qutUsername = process.env.QUT_USERNAME;
const tableName = `n11713739-videos`;

const client = new DynamoDBClient({ region: "ap-southeast-2" });

console.log("Starting DynamoDB table creation script...");
console.log("QUT Username:", qutUsername);
console.log("Table Name:", tableName);

async function createTable() {
  const command = new CreateTableCommand({
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: "qut-username", AttributeType: "S" },
      { AttributeName: "filename", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "qut-username", KeyType: "HASH" },
      { AttributeName: "filename", KeyType: "RANGE" },
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 1,
      WriteCapacityUnits: 1,
    },
  });

  try {
    console.log("Sending CreateTableCommand to DynamoDB...");
    const response = await client.send(command);
    console.log("Create Table command response:", response);
    console.log("Table creation succeeded!");
  } catch (err) {
    console.error("Error creating table:", err);
    if (err.name === "ResourceInUseException") {
      console.log("Table already exists.");
    }
    if (err.name === "CredentialsProviderError" || err.message?.includes("Token is expired")) {
      console.log("AWS credentials or SSO session may be missing or expired. Run 'aws sso login' if using SSO.");
    }
  }
}

createTable()
  .then(() => {
    console.log("Script finished.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });