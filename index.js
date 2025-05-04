require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');

// Import the database utility module
const { 
  saveData, 
  getData, 
  getReportData, 
  updateReportData, 
  reportDataExists,
  COLLECTIONS 
} = require('./db');

// Import the report generation functions
const generateReport = require('./generate-report');

const app = express();
const port = process.env.PORT || 3000;

// Check if we're running on Vercel
const isVercel = process.env.VERCEL === '1';

// Set up storage for uploaded files
const storage = isVercel 
  ? multer.memoryStorage() // Use memory storage on Vercel
  : multer.diskStorage({    // Use disk storage locally
      destination: (req, file, cb) => {
        cb(null, 'uploads/');
      },
      filename: (req, file, cb) => {
        cb(null, file.originalname);
      }
    });

// Create uploads directory if it doesn't exist and we're not on Vercel
if (!isVercel && !fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

const upload = multer({ storage: storage });

// Serve static files
app.use(express.static('public'));
app.use(express.json({ limit: '5mb' })); // Increase limit for large catalogs

// Function to filter out orders with status "Batal"
function filterCanceledOrders(data) {
  return data.filter(item => {
    // Check all possible status field names (case-insensitive)
    const statusKeys = Object.keys(item).filter(key => 
      key.toLowerCase().includes('status') || 
      key.toLowerCase().includes('pesanan') || 
      key.toLowerCase() === 'status'
    );
    
    // Check if any of the status fields has value "Batal"
    for (const key of statusKeys) {
      if (typeof item[key] === 'string' && item[key].toLowerCase() === 'batal') {
        return false; // Filter out this item
      }
    }
    
    return true; // Keep this item
  });
}

// Function to filter and keep only necessary fields
function filterNecessaryFields(data) {
  const requiredFields = [
    "No. Pesanan",
    "Status Pesanan", 
    "Waktu Pembayaran Dilakukan", 
    "Nama Produk", 
    "Nama Variasi", 
    "Harga Setelah Diskon", 
    "Jumlah", 
    "Voucher Ditanggung Penjual"
  ];
  
  return data.map(item => {
    const filteredItem = {};
    
    // Extract only the required fields
    for (const field of requiredFields) {
      // Find the closest matching field in the item (case insensitive)
      const matchingKey = Object.keys(item).find(key => 
        key.toLowerCase() === field.toLowerCase()
      );
      
      if (matchingKey) {
        filteredItem[field] = item[matchingKey];
      } else {
        // Set a default value if field not found
        if (field === "Nama Variasi" || field === "Voucher Ditanggung Penjual") {
          filteredItem[field] = "";
        } else {
          filteredItem[field] = "N/A";
        }
      }
    }
    
    return filteredItem;
  });
}

// Serve the product editor page
app.get('/product-editor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'product-editor.html'));
});

// Serve the order report page
app.get('/order-report', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'order-report.html'));
});

// Serve the simple editor page
app.get('/simple-editor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'simple-editor.html'));
});

// Serve the dashboard page
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Route for uploading and converting Excel file
app.post('/convert', upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let workbook;
    let filePath;
    
    // Handle file based on storage type
    if (isVercel) {
      // For memory storage (Vercel)
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } else {
      // For disk storage (local development)
      filePath = req.file.path;
      workbook = XLSX.readFile(filePath);
    }
    
    // Get the first sheet name
    const sheetName = workbook.SheetNames[0];
    
    // Convert sheet to JSON
    const worksheet = workbook.Sheets[sheetName];
    let jsonData = XLSX.utils.sheet_to_json(worksheet);
    
    // Filter out orders with status "Batal"
    const filteredByStatus = filterCanceledOrders(jsonData);
    
    // Filter and keep only necessary fields
    const newData = filterNecessaryFields(filteredByStatus);
    
    // Get the count of new records for reporting
    const newDataCount = newData.length;
    let existingDataCount = 0;
    let duplicateCount = 0;
    let finalData = [];
    
    // Check if we should append or replace (default is replace)
    const shouldAppend = req.body.appendData === 'true';
    
    // If append mode and there's existing data, read and merge with existing data
    if (shouldAppend) {
      try {
        // Get existing data from MongoDB
        const existingData = await getData(COLLECTIONS.ORDERS);
        
        if (existingData && existingData.length > 0) {
        // Store the count for reporting
        existingDataCount = existingData.length;
        
        // Create a map of existing order numbers for quick lookup
        const existingOrderMap = new Map();
        existingData.forEach(order => {
          // Create a unique key using order number and product name
          const key = `${order["No. Pesanan"]}-${order["Nama Produk"]}`;
          existingOrderMap.set(key, true);
        });
        
        // Filter out duplicates from the new data
        const uniqueNewData = newData.filter(order => {
          const key = `${order["No. Pesanan"]}-${order["Nama Produk"]}`;
          const isDuplicate = existingOrderMap.has(key);
          
          if (isDuplicate) {
            duplicateCount++;
            return false;
          }
          return true;
        });
        
        // Combine the datasets
        finalData = [...existingData, ...uniqueNewData];
        
        console.log(`Appending data: ${existingDataCount} existing records, ${uniqueNewData.length} new records added, ${duplicateCount} duplicates skipped`);
        } else {
          finalData = newData;
        }
      } catch (err) {
        console.error('Error reading existing data, will replace instead:', err);
        finalData = newData;
      }
    } else {
      // Replace mode - just use the new data
      finalData = newData;
      console.log(`Replacing data with ${newDataCount} records`);
    }
    
    // Save data to MongoDB
    await saveData(COLLECTIONS.ORDERS, finalData);
    
    // Automatically generate report using the data
    try {
      // Generate report using data directly (no file path needed)
      const generatedReport = await generateReport(finalData);
      
      // Check if report data exists in MongoDB
      const reportExists = await reportDataExists();
      
      if (reportExists) {
        console.log('Existing report data found in MongoDB, merging with new data');
        
        try {
          // Get existing report data
          const existingReport = await getReportData();
          
          if (existingReport && existingReport.orders) {
          // Create a map of existing order numbers to prevent duplicates
          const existingOrderMap = new Map();
          existingReport.orders.forEach(order => {
            const key = `${order.orderNumber}-${order.productName}`;
            existingOrderMap.set(key, true);
          });
          
          // Filter out duplicates from the generated report
          const uniqueNewOrders = generatedReport.orders.filter(order => {
            const key = `${order.orderNumber}-${order.productName}`;
            return !existingOrderMap.has(key);
          });
          
          console.log(`Merging ${uniqueNewOrders.length} unique new orders into existing report`);
          
          // Merge orders
          const mergedOrders = [...existingReport.orders, ...uniqueNewOrders];
          
          // Recalculate summary
          const totalEarnings = mergedOrders.reduce((sum, order) => sum + order.earnings, 0);
          const totalSubtotal = mergedOrders.reduce((sum, order) => sum + order.subtotal, 0);
          const totalMargin = mergedOrders.reduce((sum, order) => sum + order.margin, 0);
          
            // Create updated report object
          const mergedReport = {
              generatedAt: new Date(),
            summary: {
              totalOrders: mergedOrders.length,
                totalEarnings,
                averageMargin: totalEarnings > 0 ? (totalMargin / totalEarnings) * 100 : 0
            },
            orders: mergedOrders
          };
          
            // Save merged report to MongoDB
            await updateReportData(mergedReport);
            
            console.log(`Merged report saved to MongoDB with ${mergedOrders.length} orders`);
          } else {
            // If existing report doesn't have orders array, just save the generated report
            await updateReportData(generatedReport);
            console.log(`No valid existing report found, saving new report with ${generatedReport.orders.length} orders`);
          }
        } catch (err) {
          console.error('Error merging with existing report, saving new report instead:', err);
          await updateReportData(generatedReport);
        }
      } else {
        // If report doesn't exist, just save the generated report
        await updateReportData(generatedReport);
        console.log(`No existing report found, saving new report with ${generatedReport.orders.length} orders`);
      }
    } catch (err) {
      console.error('Error generating report:', err);
      // Continue with the response even if report generation fails
    }
    
    // Delete the uploaded file after processing if we're using disk storage
    if (!isVercel && filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Successfully deleted uploaded file: ${filePath}`);
      } catch (deleteErr) {
        console.error(`Warning: Failed to delete uploaded file ${filePath}:`, deleteErr);
        // Continue even if file deletion fails
      }
    }
    
    res.json({ 
      success: true, 
      message: shouldAppend ? 'File processed and data appended successfully' : 'File converted successfully and report generated',
      fileName: 'orderData.json',
      totalRows: jsonData.length,
      filteredRows: newDataCount,
      addedRows: shouldAppend ? newDataCount - duplicateCount : newDataCount,
      existingRows: existingDataCount,
      duplicateSkipped: duplicateCount,
      removedRows: jsonData.length - filteredByStatus.length,
      appendMode: shouldAppend,
      originalFileName: req.file.originalname
    });
  } catch (error) {
    console.error('Error processing file:', error);
    
    // Make sure to clean up the uploaded file in case of errors
    if (!isVercel && req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
        console.log(`Deleted uploaded file after error: ${req.file.path}`);
      } catch (deleteErr) {
        console.error(`Warning: Failed to delete uploaded file ${req.file.path}:`, deleteErr);
      }
    }
    
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to save products catalog
app.post('/api/products', async (req, res) => {
  try {
    const productCatalog = req.body;
    
    // Validate the data
    if (!productCatalog || !productCatalog.products) {
      return res.status(400).json({ error: 'Invalid product catalog data' });
    }
    
    // Update timestamp
    productCatalog.last_updated = new Date().toISOString();
    
    // Make a backup of the existing catalog in MongoDB if it exists
    const existingCatalog = await getData(COLLECTIONS.PRODUCTS);
    if (existingCatalog) {
      // Create a backup with timestamp
      const timestamp = Date.now();
      await saveData(`${COLLECTIONS.PRODUCTS}_backup_${timestamp}`, existingCatalog);
      console.log(`Backup of product catalog created in MongoDB: ${COLLECTIONS.PRODUCTS}_backup_${timestamp}`);
    }
    
    // Save the new catalog to MongoDB
    await saveData(COLLECTIONS.PRODUCTS, productCatalog);
    console.log(`Product catalog updated in MongoDB with ${productCatalog.products.length} products`);
    
    res.json({ 
      success: true, 
      message: 'Product catalog saved successfully',
      timestamp: productCatalog.last_updated
    });
  } catch (error) {
    console.error('Error saving product catalog:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route for updating product catalog
app.post('/update-catalog', async (req, res) => {
  try {
    const { productCatalog } = req.body;
    
    if (!productCatalog || !productCatalog.products) {
      return res.status(400).json({ error: 'Invalid product catalog data' });
    }
    
    // Make a backup of the existing catalog in MongoDB if it exists
    const existingCatalog = await getData(COLLECTIONS.PRODUCTS);
    if (existingCatalog) {
      // Create a backup with timestamp
      const timestamp = Date.now();
      await saveData(`${COLLECTIONS.PRODUCTS}_backup_${timestamp}`, existingCatalog);
      console.log(`Backup of product catalog created in MongoDB: ${COLLECTIONS.PRODUCTS}_backup_${timestamp}`);
    }
    
    // Save the new catalog to MongoDB
    await saveData(COLLECTIONS.PRODUCTS, productCatalog);
    console.log(`Product catalog updated in MongoDB with ${productCatalog.products.length} products`);
    
    res.json({
      success: true,
      message: `Product catalog updated with ${productCatalog.products.length} products.`
    });
  } catch (error) {
    console.error('Error updating product catalog:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route to get list of uploaded files
app.get('/files', async (req, res) => {
  try {
    // Instead of listing local files, we'll return collections
    let client;
    
    try {
      const { MongoClient } = require('mongodb');
      client = new MongoClient(process.env.MONGODB_URI);
      await client.connect();
      
      const db = client.db('myApp');
      const collections = await db.listCollections().toArray();
      
      // Map to more user-friendly format
      const files = collections.map(collection => {
        return {
          name: collection.name,
          type: 'collection',
          createdAt: new Date(),
        };
      });
      
      res.json(files);
    } catch (err) {
      console.error('Error listing MongoDB collections:', err);
      res.status(500).json({ error: 'Failed to list collections' });
    } finally {
      if (client) await client.close();
    }
  } catch (error) {
    console.error('Error listing collections:', error);
    res.status(500).json({ error: 'Failed to list collections' });
  }
});

// Function to establish MongoDB connection as early as possible and keep it warm
async function warmupDatabaseConnection() {
  try {
    console.log('Warming up database connection...');
    // Import the MongoDB module
    const { MongoClient } = require('mongodb');
    
    // Create a client with connection pooling
    const client = new MongoClient(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000
    });
    
    // Connect and test the connection
    await client.connect();
    const db = client.db('myApp');
    
    // Check if we can access the database
    const result = await db.command({ ping: 1 });
    console.log('Database warmup successful, ping result:', result);
    
    // List all collections to preload connection info
    const collections = await db.listCollections().toArray();
    console.log(`MongoDB collections available: ${collections.map(c => c.name).join(', ')}`);
    
    // Store the client in global scope to reuse the connection
    global.mongoClient = client;
    global.mongoDb = db;
    
    console.log('MongoDB connection pooling established and ready');
    return { client, db };
  } catch (error) {
    console.error('Database warmup failed:', error);
    throw error;
  }
}

// Warmup connection on server start and retry if it fails
(async function initializeDatabase() {
  try {
    await warmupDatabaseConnection();
  } catch (error) {
    console.error('Initial database connection failed, will retry in 5 seconds:', error);
    setTimeout(initializeDatabase, 5000);
  }
})();

// API endpoint to serve report data
app.get('/report-data.json', async (req, res) => {
  try {
    // Set even stronger cache control headers to prevent caching
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '-1');
    res.set('Surrogate-Control', 'no-store'); // For Vercel and CDNs
    
    console.log('Fetching report data from MongoDB...');
    const reportData = await getReportData();
    
    if (!reportData) {
      console.log('No report data found');
      return res.status(404).json({ error: 'Report data not found' });
    }
    
    const orderCount = reportData.orders ? reportData.orders.length : 0;
    console.log(`Serving report data with ${orderCount} orders. Timestamp: ${new Date().toISOString()}`);
    
    // Add a dynamic timestamp to force browser to recognize as new data
    reportData.serverTimestamp = Date.now();
    reportData.requestId = Math.random().toString(36).substring(2, 15);
    
    res.json(reportData);
  } catch (error) {
    console.error('Error serving report data:', error);
    res.status(500).json({ error: 'Failed to retrieve report data' });
  }
});

// Handle manual entry of order data
app.post('/manual-entry', async (req, res) => {
  try {
    const { orders, appendData = true } = req.body;
    
    if (!orders || !Array.isArray(orders)) {
      return res.status(400).json({ success: false, error: 'Invalid order data format' });
    }
    
    // For debugging
    console.log(`Received manual entry data: ${JSON.stringify(orders[0], null, 2).substring(0, 300)}...`);
    console.log(`Processing ${orders.length} manually entered orders (Append mode: ${appendData})`);
    
    // Get product catalog from MongoDB
    const productsCatalog = await getData(COLLECTIONS.PRODUCTS);
    if (!productsCatalog || !productsCatalog.products) {
      return res.status(404).json({ success: false, error: 'Product catalog not found or invalid' });
    }
    
    // Process manual orders
    try {
      const processedOrders = orders.map(order => {
        // Extract values from order data (handling both English and Indonesian property names)
        const productName = order.productName || order["Nama Produk"] || '';
        const variationName = order.variationName || order["Nama Variasi"] || '';
        const orderNumber = order.orderNumber || order["No. Pesanan"] || '';
        const orderDate = order.orderDate || order["Waktu Pembayaran Dilakukan"] || new Date().toISOString();
        
        // Convert string values to appropriate types
        const quantity = parseInt(order.quantity || order["Jumlah"]) || 1;
        const sellingPrice = parseFloat(order.sellingPrice || order["Harga Setelah Diskon"]) || 0;
        const mpFee = parseFloat(order.mpFee || order["MP Fee Manual"]) || 0;
        const voucher = parseFloat(order.voucher || order["Voucher Ditanggung Penjual"]) || 0;
        
        console.log(`Processing manual entry: ${orderNumber}, ${productName}, ${variationName}`);
        
        // Find product in catalog
        const product = productsCatalog.products.find(p => 
          p.product_name.toLowerCase() === productName.toLowerCase());
        
        // Find variation
        let basePrice = 0;
        if (product) {
          const variation = product.variations.find(v => 
            v.name.toLowerCase() === variationName.toLowerCase());
          
          if (variation) {
            basePrice = variation.base_price;
          }
        } else {
          console.warn(`Product not found in catalog: ${productName}`);
        }
        
        // Calculate derived fields
        const totalBasePrice = basePrice * quantity;
        const subtotal = sellingPrice * quantity;
        const earnings = subtotal - mpFee - voucher;
        const margin = earnings - totalBasePrice;
        
        // Create processed order object
        return {
          orderDate: new Date(orderDate),
          orderNumber,
          productName,
          variationName,
          quantity,
          basePrice,
          totalBasePrice,
          sellingPrice,
          subtotal,
          mpFee,
          voucher,
          earnings,
          margin
        };
      });
      
      // Check if report data exists
      const reportExists = await reportDataExists();
      let updatedReport;
      
      if (reportExists) {
        // Get existing report data
        const existingReport = await getReportData();
        
        if (existingReport && existingReport.orders) {
          // Filter out any orders with the same order number as the manually entered ones
          // (to handle updates to existing orders)
          const manualOrderNumbers = processedOrders.map(o => o.orderNumber);
          
          const filteredExistingOrders = existingReport.orders.filter(order => 
            !manualOrderNumbers.includes(order.orderNumber));
          
          // Combine existing and new orders
          const combinedOrders = [...filteredExistingOrders, ...processedOrders];
          
          // Log order counts for debugging
          console.log(`Manual entry - existing orders: ${existingReport.orders.length}`);
          console.log(`Manual entry - new orders: ${processedOrders.length}`);
          console.log(`Manual entry - filtered existing orders: ${filteredExistingOrders.length}`);
          console.log(`Manual entry - combined orders: ${combinedOrders.length}`);
          
          // Recalculate summary
          const totalEarnings = combinedOrders.reduce((sum, order) => sum + order.earnings, 0);
          const totalMargin = combinedOrders.reduce((sum, order) => sum + order.margin, 0);
          const totalRevenue = combinedOrders.reduce((sum, order) => sum + order.subtotal, 0);
          
          // Create updated report
          updatedReport = {
            generatedAt: new Date(),
            summary: {
              totalOrders: combinedOrders.length,
              totalEarnings,
              totalRevenue,
              averageMargin: totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0
            },
            orders: combinedOrders
          };
        } else {
          // Create new report with just the manual orders
          const totalEarnings = processedOrders.reduce((sum, order) => sum + order.earnings, 0);
          const totalMargin = processedOrders.reduce((sum, order) => sum + order.margin, 0);
          const totalRevenue = processedOrders.reduce((sum, order) => sum + order.subtotal, 0);
          
          updatedReport = {
            generatedAt: new Date(),
            summary: {
              totalOrders: processedOrders.length,
              totalEarnings,
              totalRevenue,
              averageMargin: totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0
            },
            orders: processedOrders
          };
      }
    } else {
        // Create new report with just the manual orders
        const totalEarnings = processedOrders.reduce((sum, order) => sum + order.earnings, 0);
        const totalMargin = processedOrders.reduce((sum, order) => sum + order.margin, 0);
        const totalRevenue = processedOrders.reduce((sum, order) => sum + order.subtotal, 0);
        
        updatedReport = {
          generatedAt: new Date(),
          summary: {
            totalOrders: processedOrders.length,
            totalEarnings,
            totalRevenue,
            averageMargin: totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0
          },
          orders: processedOrders
        };
      }
      
      // Save updated report to MongoDB
      const updateResult = await updateReportData(updatedReport);
      console.log(`Manual entry data saved to MongoDB with ${updatedReport.orders.length} orders. Result:`, updateResult);
      
      // Make sure Vercel edge cache is purged
      try {
        const purgeUrls = [
          `${req.protocol}://${req.get('host')}/report-data.json`
        ];
        
        console.log(`Attempting to purge cache for: ${purgeUrls.join(', ')}`);
      } catch (purgeError) {
        console.error('Error attempting cache purge:', purgeError);
      }
    
    res.json({
      success: true,
        message: `${processedOrders.length} manual orders saved successfully.`,
        count: processedOrders.length,
        totalCount: updatedReport.orders.length,
        timestamp: Date.now()
    });
  } catch (error) {
      console.error('Error processing manual entry:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  } catch (error) {
    console.error('Error handling manual entry:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to delete orders from the report
app.post('/delete-orders', async (req, res) => {
  try {
    const { orderNumbers } = req.body;
    
    if (!orderNumbers || !Array.isArray(orderNumbers) || orderNumbers.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid order numbers provided' });
    }
    
    // Get existing report data from MongoDB
    const reportData = await getReportData();
    
    if (!reportData || !reportData.orders) {
      return res.status(404).json({ success: false, error: 'Report data not found' });
    }
    
    // Save the deleted order numbers to the deleted orders collection
    let deletedOrdersList = await getData(COLLECTIONS.DELETED_ORDERS) || [];
    
    // Add the new deleted order numbers to the list (avoid duplicates)
    orderNumbers.forEach(orderNumber => {
      if (!deletedOrdersList.includes(orderNumber)) {
        deletedOrdersList.push(orderNumber);
      }
    });
    
    // Save the updated deleted orders list
    await saveData(COLLECTIONS.DELETED_ORDERS, deletedOrdersList);
    
    // Filter out the deleted orders from the report
    const updatedOrders = reportData.orders.filter(order => !orderNumbers.includes(order.orderNumber));
    
    // Recalculate summary
    const totalEarnings = updatedOrders.reduce((sum, order) => sum + order.earnings, 0);
    const totalMargin = updatedOrders.reduce((sum, order) => sum + order.margin, 0);
    
    // Create updated report object
    const updatedReport = {
      generatedAt: new Date(),
      summary: {
        totalOrders: updatedOrders.length,
        totalEarnings,
        averageMargin: totalEarnings > 0 ? (totalMargin / totalEarnings) * 100 : 0
      },
      orders: updatedOrders
    };
    
    // Save updated report to MongoDB
    await updateReportData(updatedReport);
    
    res.json({
      success: true,
      message: `${orderNumbers.length} orders deleted successfully.`,
      deletedCount: orderNumbers.length,
      remainingCount: updatedOrders.length
    });
  } catch (error) {
    console.error('Error deleting orders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to create a backup of the report data
app.post('/backup-report', async (req, res) => {
  try {
    // Get report data from MongoDB
    const reportData = await getReportData();
    
    if (!reportData) {
      return res.status(404).json({ 
        success: false, 
        error: 'Report data not found'
      });
    }
    
    // Create a backup with timestamp in a different collection
    const timestamp = Date.now();
    const backupCollectionName = `${COLLECTIONS.REPORT_DATA}_backup_${timestamp}`;
    
    // Save the backup to MongoDB
    await saveData(backupCollectionName, reportData);
    
    res.json({
      success: true,
      message: `Backup created successfully: ${backupCollectionName}`,
      backupName: backupCollectionName,
      timestamp: timestamp
    });
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to refresh report by regenerating it from order data
app.post('/refresh-report', async (req, res) => {
  try {
    // Get order data from MongoDB
    const orderData = await getData(COLLECTIONS.ORDERS);
    
    if (!orderData || orderData.length === 0) {
      return res.status(404).json({ error: 'Order data not found in database' });
    }
    
    // Generate fresh report
    const report = await generateReport(orderData);
    
    // Save to MongoDB
    await updateReportData(report);
    
    return res.json({
      success: true,
      message: `Report refreshed successfully with ${report.orders.length} orders.`,
      orderCount: report.orders.length
    });
  } catch (error) {
    console.error('Error refreshing report:', error);
    return res.status(500).json({ error: 'Failed to refresh report data' });
  }
});

// API endpoint to serve products catalog
app.get('/products-catalog.json', async (req, res) => {
  try {
    const productCatalog = await getData(COLLECTIONS.PRODUCTS);
    if (!productCatalog) {
      return res.status(404).json({ error: 'Product catalog not found' });
    }
    res.json(productCatalog);
  } catch (error) {
    console.error('Error serving product catalog:', error);
    res.status(500).json({ error: 'Failed to retrieve product catalog' });
  }
});

app.get('/mpfeerules.json', async (req, res) => {
  try {
    const mpFeeRules = await getData(COLLECTIONS.MPFEE_RULES);
    if (!mpFeeRules) {
      return res.status(404).json({ error: 'MP Fee rules not found' });
    }
    res.json(mpFeeRules);
  } catch (error) {
    console.error('Error serving MP Fee rules:', error);
    res.status(500).json({ error: 'Failed to retrieve MP Fee rules' });
  }
});

// Route for filtering JSON file by date range
app.post('/filter-json', async (req, res) => {
  try {
    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Both start and end dates are required' });
    }
    
    console.log(`Filtering orders between ${startDate} and ${endDate}`);
    
    // Get order data from MongoDB
    const orderData = await getData(COLLECTIONS.ORDERS);
    
    if (!orderData || orderData.length === 0) {
      return res.status(404).json({ error: 'Order data not found in database' });
    }
    
    // Parse the date strings to Date objects
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Filter the data by date range
    const filteredData = orderData.filter(order => {
      // Get the payment date field
      const paymentDate = new Date(order["Waktu Pembayaran Dilakukan"]);
      
      // Check if the payment date is within the range
      return paymentDate >= start && paymentDate <= end;
    });
    
    console.log(`Filtered ${filteredData.length} orders out of ${orderData.length} total`);
    
    // Save filtered data to MongoDB
    await saveData(COLLECTIONS.ORDERS, filteredData);
    
    // Automatically generate report from the filtered data
    try {
      // Generate report using filtered data
      const generatedReport = await generateReport(filteredData);
      
      // Check if report data exists in MongoDB
      const reportExists = await reportDataExists();
      
      if (reportExists) {
        console.log('Existing report data found in MongoDB, merging with new data');
        
        try {
          // Get existing report data
          const existingReport = await getReportData();
          
          if (existingReport && existingReport.orders) {
        // Create a map of existing order numbers to prevent duplicates
        const existingOrderMap = new Map();
        existingReport.orders.forEach(order => {
          const key = `${order.orderNumber}-${order.productName}`;
          existingOrderMap.set(key, true);
        });
        
        // Filter out duplicates from the generated report
        const uniqueNewOrders = generatedReport.orders.filter(order => {
          const key = `${order.orderNumber}-${order.productName}`;
          return !existingOrderMap.has(key);
        });
        
        console.log(`Merging ${uniqueNewOrders.length} unique new orders into existing report`);
        
          // Merge orders
          const mergedOrders = [...existingReport.orders, ...uniqueNewOrders];
          
          // Recalculate summary
          const totalEarnings = mergedOrders.reduce((sum, order) => sum + order.earnings, 0);
          const totalMargin = mergedOrders.reduce((sum, order) => sum + order.margin, 0);
          
            // Create updated report object
          const mergedReport = {
              generatedAt: new Date(),
            summary: {
              totalOrders: mergedOrders.length,
                totalEarnings,
                averageMargin: totalEarnings > 0 ? (totalMargin / totalEarnings) * 100 : 0
            },
            orders: mergedOrders
          };
          
            // Save merged report to MongoDB
            await updateReportData(mergedReport);
            
            console.log(`Merged report saved to MongoDB with ${mergedOrders.length} orders`);
        } else {
            // If existing report doesn't have orders array, just save the generated report
            await updateReportData(generatedReport);
            console.log(`No valid existing report found, saving new report with ${generatedReport.orders.length} orders`);
          }
        } catch (err) {
          console.error('Error merging with existing report, saving new report instead:', err);
          await updateReportData(generatedReport);
      }
    } else {
        // If report doesn't exist, just save the generated report
        await updateReportData(generatedReport);
        console.log(`No existing report found, saving new report with ${generatedReport.orders.length} orders`);
      }
    } catch (err) {
      console.error('Error generating report:', err);
      // Continue with the response even if report generation fails
    }
    
    res.json({ 
      success: true, 
      message: `Filtered data saved successfully. ${filteredData.length} orders matched the date range.`,
      filteredCount: filteredData.length,
      totalCount: orderData.length
    });
  } catch (error) {
    console.error('Error filtering data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Function to clean up old files in the uploads directory
function cleanupUploadsDirectory() {
  if (isVercel) return; // Skip cleanup on Vercel (using memory storage)
  
  // Clean uploads directory
  const uploadsDir = path.join(__dirname, 'uploads');
  
  // Check if uploads directory exists
  if (fs.existsSync(uploadsDir)) {
    try {
      // Get list of files in uploads directory
      const files = fs.readdirSync(uploadsDir);
      
      // Current time
      const now = new Date().getTime();
      
      // Check each file
      files.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        
        // File age in milliseconds
        const fileAge = now - stats.mtimeMs;
        
        // Delete files older than 1 hour (3600000 ms)
        if (fileAge > 3600000) {
          try {
            fs.unlinkSync(filePath);
            console.log(`Cleanup: Deleted old file ${file} from uploads (age: ${Math.round(fileAge/1000/60)} minutes)`);
          } catch (err) {
            console.error(`Cleanup: Failed to delete old file ${file}:`, err);
          }
        }
      });
    } catch (err) {
      console.error('Error cleaning up uploads directory:', err);
    }
  }
  
  // Clean public directory backups
  const publicDir = path.join(__dirname, 'public');
  
  if (fs.existsSync(publicDir)) {
    try {
      // Get list of files in public directory
      const files = fs.readdirSync(publicDir);
      
      // Current time
      const now = new Date().getTime();
      
      // Keep only the 2 most recent backup files
      const backupFiles = files
        .filter(file => file.startsWith('report-data.json.backup-'))
        .sort((a, b) => {
          // Sort by timestamp in filename, newest first
          const timestampA = parseInt(a.split('backup-')[1]);
          const timestampB = parseInt(b.split('backup-')[1]);
          return timestampB - timestampA;
        });
      
      // Delete all but the 2 most recent backups
      if (backupFiles.length > 2) {
        backupFiles.slice(2).forEach(file => {
          const filePath = path.join(publicDir, file);
          try {
            fs.unlinkSync(filePath);
            console.log(`Cleanup: Deleted old backup file ${file} (keeping only 2 most recent backups)`);
          } catch (err) {
            console.error(`Cleanup: Failed to delete backup file ${file}:`, err);
          }
        });
      }
    } catch (err) {
      console.error('Error cleaning up public directory backups:', err);
    }
  }
}

// Run cleanup when the server starts
cleanupUploadsDirectory();

// Schedule periodic cleanup (every hour)
if (!isVercel) {
  setInterval(cleanupUploadsDirectory, 3600000); // Run every hour
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Product Editor available at http://localhost:${port}/product-editor`);
}); 

// Cleanup history:
// The following files were moved to the backup directory as they're no longer needed:
// - orderData.json - Raw order data that is now stored in MongoDB
// - fix-endpoint.js - One-time script to fix API endpoints
// - init-db.js - Database initialization script that has been run
// - init-mongodb.js - Another DB initialization script that duplicates functionality
// - order-report.html - Old version of the report template now in public/
// - products-catalog.backup.*.json - Old catalog backups 