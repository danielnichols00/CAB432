// s3.js
require('dotenv').config();
const { S3Client, CreateBucketCommand, PutBucketTaggingCommand, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const region = process.env.AWS_REGION || 'ap-southeast-2';
const qutUsername = 'n11713739@qut.edu.au';
const purpose = 'prac';
const bucketName = 'n11713739-bucket';

const s3Client = new S3Client({ region });

async function createBucket() {
    const command = new CreateBucketCommand({ Bucket: bucketName });
    try {
        const response = await s3Client.send(command);
        console.log('Bucket created:', response.Location);
    } catch (err) {
        console.log('Create bucket error:', err);
    }
}

async function tagBucket() {
    const command = new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: {
            TagSet: [
                { Key: 'qut-username', Value: qutUsername },
                { Key: 'purpose', Value: purpose }
            ]
        }
    });
    try {
        const response = await s3Client.send(command);
        console.log('Tag bucket response:', response);
    } catch (err) {
        console.log('Tag bucket error:', err);
    }
}

async function putObject(objectKey, objectValue) {
    try {
        console.log(`[S3] Attempting to upload object: ${objectKey} to bucket: ${bucketName}`);
        const response = await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
            Body: objectValue
        }));
        console.log('[S3] PutObject succeeded:', response);
    } catch (err) {
        console.error('[S3] PutObject failed:', err);
        if (err.$metadata) {
            console.error('[S3] Error metadata:', err.$metadata);
        }
        if (err.Code || err.code) {
            console.error('[S3] Error code:', err.Code || err.code);
        }
        if (err.message) {
            console.error('[S3] Error message:', err.message);
        }
    }
}

async function getObject(objectKey) {
    try {
        const response = await s3Client.send(new GetObjectCommand({
            Bucket: bucketName,
            Key: objectKey
        }));
        const str = await response.Body.transformToString();
        console.log('Object value:', str);
    } catch (err) {
        console.log('Get object error:', err);
    }
}

async function getPresignedUrl(objectKey, expiresIn = 3600) {
    try {
        const command = new GetObjectCommand({ Bucket: bucketName, Key: objectKey });
        const presignedURL = await getSignedUrl(s3Client, command, { expiresIn });
        console.log('Pre-signed URL:', presignedURL);
        return presignedURL;
    } catch (err) {
        console.log('Presigned URL error:', err);
    }
}

module.exports = {
    createBucket,
    tagBucket,
    putObject,
    getObject,
    getPresignedUrl
};

// Example usage (uncomment to run directly)
// (async () => {
//     await createBucket();
//     await tagBucket();
//     await putObject('myAwesomeObjectKey', 'This could be just about anything.');
//     await getObject('myAwesomeObjectKey');
//     await getPresignedUrl('myAwesomeObjectKey');
// })();
