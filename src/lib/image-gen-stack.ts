import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import * as path from "path";
import { Construct } from "constructs";

interface ImageGenStackProps extends cdk.StackProps {
    stageName: string;
    domainName: string;
    runpodsApiKey: string;
    runpodsEndpoint: string;
    awsOutputBucketPrefix: string;
    awsWebsiteBucketPrefix: string;
    devWebsiteUsername?: string;
    devWebsitePassword?: string;
}

export class ImageGenStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ImageGenStackProps) {
        super(scope, id, props);

        // Create SSL certificate for the domain
        const certificate = new acm.Certificate(this, "Certificate", {
            domainName: props.domainName,
            validation: acm.CertificateValidation.fromDns(), // Will provide DNS records to add to Namecheap
        });

        // Output bucket for generated images
        const outputBucket = new s3.Bucket(this, "ImageGenOutputBucket", {
            bucketName: `${props.awsOutputBucketPrefix}-${this.account}-${props.stageName}`, // Make unique per account
            publicReadAccess: true,
            cors: [
                {
                    allowedMethods: [s3.HttpMethods.GET],
                    allowedOrigins: ["*"],
                    allowedHeaders: ["*"],
                },
            ],
            blockPublicAccess: new s3.BlockPublicAccess({
                blockPublicAcls: false,
                blockPublicPolicy: false,
                ignorePublicAcls: false,
                restrictPublicBuckets: false,
            }),
        });

        // IAM user for uploading to output bucket
        const uploadUser = new iam.User(this, "ImageUploadUser");

        // Create access key and store in Secrets Manager
        const accessKey = new iam.AccessKey(this, "ImageUploadUserAccessKey", {
            user: uploadUser,
        });

        const uploadCredentialsSecret = new secretsmanager.Secret(
            this,
            "UploadCredentials",
            {
                secretObjectValue: {
                    accessKeyId: cdk.SecretValue.unsafePlainText(
                        accessKey.accessKeyId
                    ),
                    secretAccessKey: accessKey.secretAccessKey,
                },
            }
        );

        // Grant upload permissions
        outputBucket.grantWrite(uploadUser);

        // Website bucket for static files
        const websiteBucket = new s3.Bucket(this, "ImageGenWebsiteBucket", {
            bucketName: `${props.awsWebsiteBucketPrefix}-${this.account}-${props.stageName}`, // Make unique per account
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        });

        // CloudFront distribution origin access identity
        const originAccessIdentity = new cloudfront.OriginAccessIdentity(
            this,
            `CloudFrontOAI`,
            {
                comment: `OAI for CloudFront -> S3 ${websiteBucket.bucketName}`,
            }
        );

        // Create CloudFront Function for basic auth when in dev stage
        let basicAuthFunction: cloudfront.Function | undefined;
        let basicAuthFunctionAssociation: {} | undefined;

        if (props.stageName === "dev") {
            // Base64 encode the credentials
            const credentials = Buffer.from(
                `${props.devWebsiteUsername}:${props.devWebsitePassword}`
            ).toString("base64");

            basicAuthFunction = new cloudfront.Function(
                this,
                `BasicAuthFunction`,
                {
                    code: cloudfront.FunctionCode.fromInline(`
                    function handler(event) {
                        var request = event.request;
                        var headers = request.headers;
                        
                        // Check for Basic auth header
                        if (!headers.authorization) {
                            return {
                                statusCode: 401,
                                statusDescription: 'Unauthorized',
                                headers: {
                                    'www-authenticate': { value: 'Basic' }
                                }
                            };
                        }

                        // Verify credentials
                        var authHeader = headers.authorization.value;
                        var expectedHeader = 'Basic ${credentials}';
                        
                        if (authHeader !== expectedHeader) {
                            return {
                                statusCode: 401,
                                statusDescription: 'Unauthorized',
                                headers: {
                                    'www-authenticate': { value: 'Basic' }
                                }
                            };
                        }
                        
                        return request;
                    }
                `),
                }
            );
            basicAuthFunctionAssociation = {
                functionAssociations: [
                    {
                        function: basicAuthFunction,
                        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                    },
                ],
            };
        }

        // CloudFront distribution
        const distribution = new cloudfront.Distribution(
            this,
            `WebsiteDistribution`,
            {
                defaultBehavior: {
                    origin: new origins.S3Origin(websiteBucket, {
                        originAccessIdentity: originAccessIdentity, // Use OAI here
                    }),
                    viewerProtocolPolicy:
                        cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                    ...(props.stageName === "dev" &&
                        basicAuthFunction &&
                        basicAuthFunctionAssociation),
                },
                defaultRootObject: "index.html", // Add this to serve index.html by default
                priceClass:
                    props.stageName === "dev"
                        ? cloudfront.PriceClass.PRICE_CLASS_100
                        : cloudfront.PriceClass.PRICE_CLASS_ALL,
                errorResponses: [
                    // Add error responses for SPA support
                    {
                        httpStatus: 403,
                        responseHttpStatus: 200,
                        responsePagePath: "/index.html?e=403",
                    },
                    {
                        httpStatus: 404,
                        responseHttpStatus: 200,
                        responsePagePath: "/index.html?e=404",
                    },
                ],
                domainNames: [props.domainName],
                certificate: certificate,
            }
        );

        // API Gateway
        const api = new apigateway.RestApi(this, "ImageGenApi", {
            restApiName: `ImageGenerationAPI-${this.account}-${props.stageName}`,
            defaultCorsPreflightOptions: {
                allowOrigins: ["*"],
                allowMethods: ["POST", "GET", "OPTIONS"],
            },
        });

        // Request model for validation
        const runRequestModel = api.addModel("RunRequestModel", {
            contentType: "application/json",
            modelName: `RunRequestModel${this.account}${props.stageName}`,
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                required: ["prompt"],
                properties: {
                    prompt: { type: apigateway.JsonSchemaType.STRING },
                    workflow: { type: apigateway.JsonSchemaType.STRING },
                },
            },
        });

        // Integration with Runpods
        const runpodsIntegration = new apigateway.HttpIntegration(
            `${props.runpodsEndpoint}/run`,
            {
                httpMethod: "POST",
                options: {
                    requestParameters: {
                        "integration.request.header.Authorization": `'Bearer ${props.runpodsApiKey}'`,
                    },
                },
            }
        );

        const statusIntegration = new apigateway.HttpIntegration(
            `${props.runpodsEndpoint}/status/{jobId}`,
            {
                httpMethod: "GET",
                options: {
                    requestParameters: {
                        "integration.request.header.Authorization": `'Bearer ${props.runpodsApiKey}'`,
                        "integration.request.path.jobId":
                            "method.request.path.jobId",
                    },
                },
            }
        );

        // POST /run endpoint
        const runResource = api.root.addResource("run");
        runResource.addMethod("POST", runpodsIntegration, {
            requestModels: {
                "application/json": runRequestModel,
            },
            requestValidator: new apigateway.RequestValidator(
                this,
                `RunRequestValidator`,
                {
                    restApi: api,
                    validateRequestBody: true,
                }
            ),
        });

        // GET /status/{jobId} endpoint
        const statusResource = api.root
            .addResource("status")
            .addResource("{jobId}");
        statusResource.addMethod("GET", statusIntegration, {
            requestParameters: {
                "method.request.path.jobId": true,
            },
        });

        // Stack Outputs
        new cdk.CfnOutput(this, "CertificateValidationRecords", {
            value:
                "IMPORTANT!! Check Certificate Manager in AWS Console for DNS validation records to add to Namecheap. " +
                "Initial stack deployment won't complete until the DNS is updated & propagates (which takes a while).",
            description: "DNS records needed for SSL certificate validation",
        });

        new cdk.CfnOutput(this, "CloudFrontDomainSetup", {
            value: `Domain: ${props.domainName}\nType: CNAME\nTarget: ${distribution.distributionDomainName}`,
            description:
                "CloudFront Domain CNAME record to add in external DNS provider ie. Namecheap, GoDaddy, Yandex",
        });

        new cdk.CfnOutput(this, "UploadCredentialsSecretArn", {
            value: uploadCredentialsSecret.secretArn,
            description: "ARN of the secret containing upload credentials",
        });

        new cdk.CfnOutput(this, "ApiUrl", {
            value: api.url,
            description: "URL of the API Gateway endpoint",
        });

        new cdk.CfnOutput(this, "OutputBucketName", {
            value: outputBucket.bucketName,
            description: "Bucket name for storing generated images",
        });

        new cdk.CfnOutput(this, "WebsiteBucketName", {
            value: websiteBucket.bucketName,
            description: "Bucket name for website files",
        });
    }
}
