import 'source-map-support/register';
import { App, Environment } from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';
import { EdgeStack } from '../lib/edge-stack';

const app = new App();
const env: Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-southeast-2',
};

const data = new DataStack(app, 'TranscoderData', { env });
const compute = new ComputeStack(app, 'TranscoderCompute', {
  env,
  jobsTable: data.jobsTable,
  queue: data.jobsQueue,
  dlq: data.dlq,
  rawBucketName: process.env.RAW_BUCKET_NAME!,          // set before deploy
  processedBucketName: process.env.PROCESSED_BUCKET_NAME! // set before deploy
});

// HTTPS + DNS (ALB) for the API
new EdgeStack(app, 'TranscoderEdge', {
  env,
  alb: compute.alb,
  hostName: process.env.SUBDOMAIN || 'n11070315.cab432.com', // change me
  certificateArn: process.env.CERT_ARN || 'arn:aws:acm:ap-southeast-2:ACCOUNT:certificate/UUID' // change me
});
