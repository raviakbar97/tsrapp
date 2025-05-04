# Setting Up MongoDB Atlas for the Application

## Overview
This application has been refactored to use MongoDB Atlas as its database instead of local file system storage. This is necessary because Vercel has a read-only file system, which prevents writing to files.

## Step 1: Create a MongoDB Atlas account
1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) and sign up for a free account (or log in if you already have an account).
2. Create a new organization if you don't have one already.

## Step 2: Create a new project
1. Create a new project within your organization.
2. Name it something relevant like "TSRApp".

## Step 3: Create a cluster
1. Click "Build a Database" to create a new cluster.
2. Choose the free tier (M0 Sandbox) option.
3. Select your preferred cloud provider and region (choose a region closest to your users for better performance).
4. Name your cluster (e.g., "tsrapp-cluster").
5. Click "Create Cluster".

## Step 4: Set up database access
1. While your cluster is being created, go to the "Database Access" section under "Security".
2. Click "Add New Database User".
3. Choose "Password" for authentication method.
4. Enter a username and a secure password (save these credentials - you'll need them later).
5. Set the database user privileges to "Atlas admin" for simplicity.
6. Click "Add User".

## Step 5: Configure network access
1. Go to the "Network Access" section under "Security".
2. Click "Add IP Address".
3. To allow access from anywhere, click "Allow Access from Anywhere" (for a production app, you might want to restrict this later).
4. Click "Confirm".

## Step 6: Get your connection string
1. Go back to the "Database" section and click "Connect".
2. Select "Connect your application".
3. Make sure "Node.js" is selected as the driver, and the appropriate version is chosen.
4. Copy the connection string. It will look something like:
   ```
   mongodb+srv://<username>:<password>@tsrapp-cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
5. Replace `<username>` and `<password>` with the credentials you created earlier.

## Step 7: Configure Vercel environment variables
1. Go to your Vercel project.
2. Go to the "Settings" tab.
3. Select "Environment Variables" from the sidebar.
4. Add a new environment variable:
   - Name: `MONGODB_URI`
   - Value: Your MongoDB Atlas connection string (the one you customized with your credentials)
5. Click "Save" to add the environment variable.

## Step 8: Initialize the database collections (first deployment)
After deploying your application for the first time, you'll need to upload some initial data to create the collections:
1. Use the product editor page to upload your product catalog.
2. Use the upload feature to upload your order data.

## Database Structure
The application uses the following collections:
- `orders` - Stores the raw order data
- `products` - Stores the product catalog
- `mpfeeRules` - Stores the marketplace fee rules
- `reportData` - Stores the generated report
- `deletedOrders` - Stores a list of deleted order IDs

## Troubleshooting
- If you encounter connection issues, make sure your IP is allowed in the "Network Access" section.
- Check if your connection string is correctly formatted with the right username and password.
- Verify that the environment variable is correctly set in Vercel.

## Local Development
For local development, you can set the `MONGODB_URI` environment variable in a `.env` file (don't commit this file to git): 