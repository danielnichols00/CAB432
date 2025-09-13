Assignment 1 - REST API Project - Response to Criteria
================================================

Overview
------------------------------------------------

- **Name:** Daniel Nichols
- **Student number:** n11713739
- **Application name:** Video Transcoder App (transcoderapp)
- **Two line description:** This REST API provides a way for users to upload videos and make requests for video transcoding using ffmpeg. It has storage for uploaded videos
- and processed videos. It has admin and user logins to determine access levels for endpoints using JWT. It uses node.js and express for the functionality. Metadata is stored in a db.json file


Core criteria
------------------------------------------------

### Containerise the app

- **ECR Repository name:** n11713739-repo
- **Video timestamp:** 00:15
- **Relevant files:** Dockerfile / package.json
    - 

### Deploy the container

- **EC2 instance ID:** i-0f99b134e3a18b3a5
- **Video timestamp:** 01:10

### User login

- **One line description:** The user login required a username and password and returns a token to be used for authentication. User and admin logins available
- **Video timestamp:** 01:16
- **Relevant files:** jwt.js
    - 

### REST API

- **One line description:** REST interface allows uploading of videos and transcoding videos. Ability to list metadata and download files (not shown)
- **Video timestamp:** REST Endpoint explanations @ 01:53 / upload videos using API @ 03:34
- **Relevant files:** index.js / routes/videos.js / transcode.js
    - 

### Data types

- **One line description:** The app stores video files and metadata of information regarding the user account and details of the upload times and names etc
- **Video timestamp:** 03:43 @ 02:21
- **Relevant files:** data/db.json / data (directory containing uploads and processed for video storage) / routes/videos.js
    - 

#### First kind

- **One line description:** Unstructured video files such as MP4 stored in data directories: uploads/processed - stored on EC2 instance persitently after uploaded via docker container
- **Type:** Unstructured video files - MP4 used in demo
- **Rationale:** Large video files best not to be stored in a db
- **Video timestamp:** 03:43
- **Relevant files:** data/uploads and data/processed
    - 

#### Second kind

- **One line description:** Metadata storing ownership information, filenames and timestamps 
- **Type:** structured in a JSON file
- **Rationale:** Low storage requirement and used for get endpoint
- **Video timestamp:** 02:21
- **Relevant files:** data/db.json and routes/video.js
  - 

### CPU intensive task

 **One line description:** Video transcoding using ffmpeg - H.264 encoding
- **Video timestamp:** 03:54
- **Relevant files:** transcode.js / Dockerfile / routes/videos.js
    - 

### CPU load testing

 **One line description:** Queing 10 videos for transcoding puts a large amount of stress on the CPU over a long period of time (medium preset and CRF 23). Observed with htop
- **FYI** I accidentally muted my microphone at the last 20-30 seconds where I explained that express and node.js are used for the API & that H.264 encoding was the intensive task (please forgive me)
- **Video timestamp:** 04:14
- **Relevant files:** transcode.js / routes/videos.js (trigger)
    - 

Additional criteria
------------------------------------------------

### Extensive REST API features

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### External API(s)

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Additional types of data

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Custom processing

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Infrastructure as code

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Web client

- **One line description:**
- **Video timestamp:**
- **Relevant files:**
    -   

### Upon request

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
