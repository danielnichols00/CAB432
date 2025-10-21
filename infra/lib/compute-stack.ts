import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Vpc, SecurityGroup, Peer, Port } from 'aws-cdk-lib/aws-ec2';
import { Cluster, ContainerImage, FargateService, FargateTaskDefinition, LogDriver, Protocol } from 'aws-cdk-lib/aws-ecs';
import { AwsLogDriverMode } from 'aws-cdk-lib/aws-ecs/lib/log-drivers/aws-log-driver';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { ApplicationLoadBalancer, ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';

interface Props extends StackProps {
  jobsTable: Table;
  queue: Queue;
  dlq: Queue;
  rawBucketName: string;
  processedBucketName: string;
}

export class ComputeStack extends Stack {
  public readonly cluster: Cluster;
  public readonly apiService: FargateService;
  public readonly workerService: FargateService;
  public readonly alb: ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', { maxAzs: 2 });
    this.cluster = new Cluster(this, 'Cluster', { vpc });

    // --- Security (simple) ---
    const sg = new SecurityGroup(this, 'AlbSG', { vpc, allowAllOutbound: true });
    sg.addIngressRule(Peer.anyIpv4(), Port.tcp(80));

    // --- ALB in front of API ---
    this.alb = new ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: sg
    });
    const http = this.alb.addListener('Http', { port: 80, protocol: ApplicationProtocol.HTTP });

    // --- API Task ---
    const apiTask = new FargateTaskDefinition(this, 'ApiTask', { cpu: 256, memoryLimitMiB: 512 });
    apiTask.addContainer('api', {
      image: ContainerImage.fromRegistry(process.env.API_IMAGE || 'public.ecr.aws/docker/library/node:20-alpine'), // replace with your ECR image
      portMappings: [{ containerPort: 3000, protocol: Protocol.TCP }],
      logging: LogDriver.awsLogs({ streamPrefix: 'api', mode: AwsLogDriverMode.NON_BLOCKING }),
      environment: {
        AWS_REGION: Stack.of(this).region,
        QUEUE_URL: props.queue.queueUrl,
        JOBS_TABLE: props.jobsTable.tableName
      }
    });
    this.apiService = new FargateService(this, 'ApiService', {
      cluster: this.cluster,
      taskDefinition: apiTask,
      desiredCount: 1,
    });
    http.addTargets('ApiTG', { port: 3000, protocol: ApplicationProtocol.HTTP, targets: [this.apiService] });

    // API permissions
    props.jobsTable.grantReadWriteData(apiTask.taskRole);
    props.queue.grantSendMessages(apiTask.taskRole);

    // --- Worker Task ---
    const workerTask = new FargateTaskDefinition(this, 'WorkerTask', { cpu: 512, memoryLimitMiB: 1024 });
    workerTask.addContainer('worker', {
      image: ContainerImage.fromRegistry(process.env.WORKER_IMAGE || 'public.ecr.aws/docker/library/node:20-bookworm'), // replace with your ECR image
      logging: LogDriver.awsLogs({ streamPrefix: 'worker', mode: AwsLogDriverMode.NON_BLOCKING }),
      environment: {
        AWS_REGION: Stack.of(this).region,
        QUEUE_URL: props.queue.queueUrl,
        RAW_BUCKET: props.rawBucketName,
        PROCESSED_BUCKET: props.processedBucketName,
        JOBS_TABLE: props.jobsTable.tableName,
        SQS_WAIT_SECONDS: '20',
        SQS_VISIBILITY: '300'
      }
    });
    this.workerService = new FargateService(this, 'WorkerService', {
      cluster: this.cluster,
      taskDefinition: workerTask,
      desiredCount: 1,
    });

    // Worker permissions
    props.jobsTable.grantReadWriteData(workerTask.taskRole);
    props.queue.grantConsumeMessages(workerTask.taskRole);

    // S3 perms (least privilege)
    workerTask.addToTaskRolePolicy(new PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.rawBucketName}/*`]
    }));
    workerTask.addToTaskRolePolicy(new PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::${props.processedBucketName}/*`]
    }));

    // --- Autoscaling worker 1 -> 3 -> 1 based on backlog ---
    const scaling = this.workerService.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 3 });
    scaling.scaleOnMetric('SqsBacklog', {
      metric: props.queue.metricApproximateNumberOfMessagesVisible(),
      scalingSteps: [
        { lower: 1, change: +1 },
        { lower: 5, change: +2 }
      ],
      cooldown: Duration.seconds(60)
    });
  }
}

