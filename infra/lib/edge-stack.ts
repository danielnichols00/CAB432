import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { ApplicationLoadBalancer, ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';

interface Props extends StackProps {
  alb: ApplicationLoadBalancer;
  hostName: string;        // e.g. n11070315.cab432.com
  certificateArn: string;  // ACM cert in ap-southeast-2
}

export class EdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const zone = HostedZone.fromLookup(this, 'Zone', { domainName: 'cab432.com' });
    const cert = Certificate.fromCertificateArn(this, 'Cert', props.certificateArn);

    // Add HTTPS (443) listener with cert, keep HTTP as redirect
    const https = props.alb.addListener('Https', { port: 443, protocol: ApplicationProtocol.HTTPS, certificates: [cert] });
    https.addTargets('HttpsApi', { port: 3000, targets: props.alb.listeners[0].node.tryFindChild('ApiTG') as any });

    // Optional: redirect 80 -> 443
    // props.alb.addRedirect({ sourcePort: 80, targetPort: 443 });

    // DNS
    new ARecord(this, 'ApiAlias', {
      zone,
      recordName: props.hostName.replace('.cab432.com', ''),
      target: RecordTarget.fromAlias(new LoadBalancerTarget(props.alb)),
    });
  }
}
