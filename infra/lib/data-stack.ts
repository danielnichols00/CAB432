import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Queue, DeadLetterQueue } from 'aws-cdk-lib/aws-sqs';

export class DataStack extends Stack {
  public readonly jobsTable: Table;
  public readonly jobsQueue: Queue;
  public readonly dlq: Queue;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.jobsTable = new Table(this, 'JobsTable', {
      partitionKey: { name: 'jobId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    this.dlq = new Queue(this, 'JobsDLQ', {
      retentionPeriod: Duration.days(14)
    });

    this.jobsQueue = new Queue(this, 'JobsQueue', {
      visibilityTimeout: Duration.seconds(300),
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 5 }
    });
  }
}
