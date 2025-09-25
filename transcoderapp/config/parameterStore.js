// config/parameterStore.js
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const client = new SSMClient({ region: "ap-southeast-2" });

async function getParameter(name) {
  try {
    const response = await client.send(new GetParameterCommand({ Name: name }));
    return response.Parameter.Value;
  } catch (err) {
    console.error("Parameter Store error:", err);
    return null;
  }
}

module.exports = { getParameter };
