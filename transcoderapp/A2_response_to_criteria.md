# Assignment 2 - Cloud Services Exercises - Response to Criteria

## Instructions

- Keep this file named A2_response_to_criteria.md, do not change the name
- Upload this file along with your code in the root directory of your project
- Upload this file in the current Markdown format (.md extension)
- Do not delete or rearrange sections. If you did not attempt a criterion, leave it blank
- Text inside [ ] like [eg. S3 ] are examples and should be removed

## Overview

- **Name:** Daniel Nichols
- **Student number:** n11713739
- **Partner name (if applicable):** Daniel Brown
- **Application name:** Video Transcoder App
- **Two line description:** We developed an app with a working frontend that allows users to create accounts and upload videos. Uploaded videos can be transcoded and downloaded with varying file encoding and quality preferences.
- **EC2 instance name or ID:** i-0f99b134e3a18b3a5

---

### Core - First data persistence service

- **AWS service name:** S3
- **What data is being stored?:** Video files
- **Why is this service suited to this data?:** Large files are best suited to blob storage due to size restrictions on other services
- **Why is are the other services used not suitable for this data?:** DynamoDB and RDS are better suited for smaller file types such as metadata and other text files.
- **Bucket/instance/table name:** n11713739-bucket
- **Video timestamp:** 00:08
- ## **Relevant files:** s3.js / videos.js / index.html

### Core - Second data persistence service

- **AWS service name:** DynamoDB
- **What data is being stored?:** Metadata related to the user and the video files
- **Why is this service suited to this data?:** Provides fast and well structured storage for this type of data.
- **Why is are the other services used not suitable for this data?:** DynamoDB is less complex to scale than RDS
- **Bucket/instance/table name:** n11713739-videos
- **Video timestamp:** 00:15
- ## **Relevant files:** dynamodb.js / videos.js

### Third data service

- **AWS service name:**
- **What data is being stored?:**
- **Why is this service suited to this data?:**
- **Why is are the other services used not suitable for this data?:**
- **Bucket/instance/table name:**
- **Video timestamp:**
- ## **Relevant files:**

### S3 Pre-signed URLs

- **S3 Bucket names:** n11713739-bucket
- **Video timestamp:**
- ## **Relevant files:** s3.js / videos.js / index.html

### In-memory cache

- **ElastiCache instance name:** n11713739-cache
- **What data is being cached?:** Uploads information list
- **Why is this data likely to be accessed frequently?:** The frontend displays the videos as a list when logged in, so is frequently refreshed if the user performs an action etc.
- **Video timestamp:** 01:36
- ## **Relevant files:** videos.js

### Core - Statelessness

- **What data is stored within your application that is not stored in cloud data services?:** There are temp file stored during transcoding
- **Why is this data not considered persistent state?:** Intermediate files can be recreated from source if they are lost
- **How does your application ensure data consistency if the app suddenly stops?:** Data is all stored in S3 and Dynamo and is not lost if the app were to suddenly crash or if connectivity is severed.
- ## **Relevant files:** transcode.js / videos.js

### Graceful handling of persistent connections

- **Type of persistent connection and use:**
- **Method for handling lost connections:**
- ## **Relevant files:**

### Core - Authentication with Cognito

- **User pool name:**
- **How are authentication tokens handled by the client?:** Login Request validates with Cognito database, sets JWT token.
- **Video timestamp:** 04:45
- **Relevant files:**
  - auth/cognito.js
  - auth/jwt.js

### Cognito multi-factor authentication

- **What factors are used for authentication:**
- **Video timestamp:**
- ## **Relevant files:**

### Cognito federated identities

- **Identity providers used:**
- **Video timestamp:**
- ## **Relevant files:**

### Cognito groups

- **How are groups used to set permissions?:** admin group allows admins to view all files in the database, non admins can only view what they have uploaded to database.
- **Video timestamp:** 05:09
- **Relevant files:**
  - index.html (loadIdentity function checks if user is Admin)

### Core - DNS with Route53

- **Subdomain**: n11070315.cab432.com
- **Video timestamp:** 03:16

### Parameter store

- **Parameter names:** /n11713739/aws_region - /n11713739/dynamotable - /n11713739/s3bucket
- **Video timestamp:** 02:25
- ## **Relevant files:** parameterStore.js / s3.js / dynamodb.js

### Secrets manager

- **Secrets names:** n11070315-assignment2-transcoder
- **Video timestamp:** 03:38
- ## **Relevant files:**
  - bootstrap/secrets.js

### Infrastructure as code

- **Technology used:**
- **Services deployed:**
- **Video timestamp:**
- ## **Relevant files:**

### Other (with prior approval only)

- **Description:**
- **Video timestamp:**
- ## **Relevant files:**

### Other (with prior permission only)

- **Description:**
- **Video timestamp:**
- ## **Relevant files:**
