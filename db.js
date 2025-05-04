const { MongoClient } = require('mongodb');

// Database Name
const dbName = 'myApp';

// Collection names
const COLLECTIONS = {
  ORDERS: 'orders',
  PRODUCTS: 'products',
  MPFEE_RULES: 'mpfeeRules',
  DELETED_ORDERS: 'deletedOrders',
  REPORT_DATA: 'reportData'
};

// Connect to MongoDB
async function connectToDatabase() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI environment variable is not set');
    console.error('Please check that the .env file exists and contains MONGODB_URI');
    console.error('Or set it in your environment variables if deploying to Vercel');
    throw new Error('MONGODB_URI environment variable is not set');
  }

  // MongoDB connection options
  const options = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 15000, // Longer timeout for Vercel
    connectTimeoutMS: 15000,
    socketTimeoutMS: 45000,
    ssl: true,
    tls: true,
    tlsCAFile: null, // Let MongoDB driver handle the certificates
    maxPoolSize: 10,
    minPoolSize: 5
  };

  try {
    console.log('Connecting to MongoDB...');
    const client = new MongoClient(process.env.MONGODB_URI, options);
    await client.connect();
    console.log('Successfully connected to MongoDB');
    return { client, db: client.db(dbName) };
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}

// Save data to a collection
async function saveData(collectionName, data) {
  let client;
  try {
    const { client: newClient, db } = await connectToDatabase();
    client = newClient;
    const collection = db.collection(collectionName);
    
    // If data is an array, insert many documents
    if (Array.isArray(data)) {
      if (data.length === 0) return { success: true, count: 0 };
      await collection.deleteMany({}); // Clear collection first
      const result = await collection.insertMany(data);
      return { success: true, count: result.insertedCount };
    } 
    // If data is an object, insert or replace a single document
    else {
      await collection.deleteMany({}); // Clear collection first
      const result = await collection.insertOne(data);
      return { success: true, insertedId: result.insertedId };
    }
  } catch (error) {
    console.error(`Error saving data to ${collectionName}:`, error);
    throw error;
  } finally {
    if (client) await client.close();
  }
}

// Get data from a collection
async function getData(collectionName) {
  let client;
  try {
    const { client: newClient, db } = await connectToDatabase();
    client = newClient;
    const collection = db.collection(collectionName);
    
    // Special case for PRODUCTS collection - return the document directly without modification
    if (collectionName === COLLECTIONS.PRODUCTS) {
      const productDoc = await collection.findOne({});
      return productDoc; // This maintains the original structure with products array
    }
    // Special case for MP fee rules
    else if (collectionName === COLLECTIONS.MPFEE_RULES) {
      const rulesDoc = await collection.findOne({});
      return rulesDoc; // Return the entire rules document
    }
    // For collections like ORDERS, DELETED_ORDERS that store arrays of data
    else if ([COLLECTIONS.ORDERS, COLLECTIONS.DELETED_ORDERS].includes(collectionName)) {
      const documents = await collection.find({}).toArray();
      // If we have multiple documents, combine them into a single array
      if (documents.length > 0) {
        // Extract the data from each document and flatten
        let allData = [];
        documents.forEach(doc => {
          if (Array.isArray(doc.data)) {
            allData = [...allData, ...doc.data];
          } else {
            allData.push(doc);
          }
        });
        return allData;
      }
      return [];
    } 
    // For REPORT_DATA collection
    else {
      const data = await collection.findOne({});
      return data || null;
    }
  } catch (error) {
    console.error(`Error getting data from ${collectionName}:`, error);
    throw error;
  } finally {
    if (client) await client.close();
  }
}

// Update or insert report data
async function updateReportData(reportData) {
  let client;
  try {
    const { client: newClient, db } = await connectToDatabase();
    client = newClient;
    const collection = db.collection(COLLECTIONS.REPORT_DATA);
    
    // Delete existing report data
    await collection.deleteMany({});
    
    // Insert new report data
    const result = await collection.insertOne(reportData);
    return { success: true, insertedId: result.insertedId };
  } catch (error) {
    console.error('Error updating report data:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
}

// Get report data
async function getReportData() {
  let client;
  try {
    const { client: newClient, db } = await connectToDatabase();
    client = newClient;
    const collection = db.collection(COLLECTIONS.REPORT_DATA);
    
    const reportData = await collection.findOne({});
    return reportData || null;
  } catch (error) {
    console.error('Error getting report data:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
}

// Check if report data exists
async function reportDataExists() {
  let client;
  try {
    const { client: newClient, db } = await connectToDatabase();
    client = newClient;
    const collection = db.collection(COLLECTIONS.REPORT_DATA);
    
    const count = await collection.countDocuments();
    return count > 0;
  } catch (error) {
    console.error('Error checking if report data exists:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
}

// Export the functions and constants
module.exports = {
  connectToDatabase,
  saveData,
  getData,
  updateReportData,
  getReportData,
  reportDataExists,
  COLLECTIONS
}; 