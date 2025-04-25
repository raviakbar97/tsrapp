const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

// Import the report generation functions
const generateReport = require('./generate-report');

const app = express();
const port = 3000;

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
app.post('/convert', upload.single('excelFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let workbook;
    
    // Handle file based on storage type
    if (isVercel) {
      // For memory storage (Vercel)
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } else {
      // For disk storage (local development)
      const filePath = req.file.path;
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
    
    // Standard output filename
    const outputFilename = 'orderData.json';
    const outputPath = path.join(__dirname, outputFilename);
    
    // Check if we should append or replace (default is replace)
    const shouldAppend = req.body.appendData === 'true';
    
    // Get the count of new records for reporting
    const newDataCount = newData.length;
    let existingDataCount = 0;
    let duplicateCount = 0;
    let finalData = [];
    
    // If append mode and the file exists, read and merge with existing data
    if (shouldAppend && fs.existsSync(outputPath)) {
      try {
        // Read existing data
        const existingDataRaw = fs.readFileSync(outputPath);
        const existingData = JSON.parse(existingDataRaw);
        
        // Store the count for reporting
        existingDataCount = existingData.length;
        
        // Create a map of existing order numbers for quick lookup
        const existingOrderMap = new Map();
        existingData.forEach(order => {
          // Create a unique key using order number and product name
          // Use the actual field names from the JSON data structure
          const key = `${order["No. Pesanan"]}-${order["Nama Produk"]}`;
          existingOrderMap.set(key, true);
        });
        
        // Filter out duplicates from the new data
        const uniqueNewData = newData.filter(order => {
          // Use the actual field names from the JSON data structure
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
      } catch (err) {
        console.error('Error reading existing data, will replace instead:', err);
        finalData = newData;
      }
    } else {
      // Replace mode - just use the new data
      finalData = newData;
      console.log(`Replacing data with ${newDataCount} records`);
    }
    
    // Write JSON to file
    fs.writeFileSync(outputPath, JSON.stringify(finalData, null, 2));
    
    // Automatically generate report using the newly created JSON file
    try {
      // Instead of replacing report-data.json, we'll append the data from orderData.json
      const generatedReport = generateReport(outputPath);
      
      // After generating the report, we need to merge with existing report data
      const reportDataFile = path.join(__dirname, 'public', 'report-data.json');
      
      // If report-data.json exists, we'll merge with it
      if (fs.existsSync(reportDataFile)) {
        console.log('Existing report-data.json found, merging with new data');
        
        try {
          // Read existing report data
          const existingReport = JSON.parse(fs.readFileSync(reportDataFile, 'utf8'));
          
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
          
          const mergedReport = {
            summary: {
              totalOrders: mergedOrders.length,
              totalEarnings: totalEarnings,
              averageMargin: totalSubtotal > 0 ? (totalMargin / totalSubtotal) * 100 : 0
            },
            orders: mergedOrders
          };
          
          // Save the merged report
          fs.writeFileSync(reportDataFile, JSON.stringify(mergedReport, null, 2));
          console.log(`Successfully merged data into ${reportDataFile}`);
        } catch (mergeError) {
          console.error('Error merging with existing report data:', mergeError);
          
          // If there's an error merging, just save the generated report as is
          fs.writeFileSync(reportDataFile, JSON.stringify(generatedReport, null, 2));
          console.log(`Error merging, saved generated report to ${reportDataFile}`);
        }
      } else {
        // If report-data.json doesn't exist, just save the generated report
        fs.writeFileSync(reportDataFile, JSON.stringify(generatedReport, null, 2));
        console.log(`No existing report found, saved generated report to ${reportDataFile}`);
      }
      
      console.log('Report automatically generated after file conversion');
    } catch (reportError) {
      console.error('Error generating report:', reportError);
    }
    
    // Delete the original uploaded Excel file if using disk storage
    if (!isVercel && req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
        console.log(`Deleted uploaded Excel file: ${req.file.path}`);
      } catch (deleteError) {
        console.error('Error deleting uploaded Excel file:', deleteError);
      }
    }
    
    res.json({ 
      success: true, 
      message: shouldAppend ? 'File processed and data appended successfully' : 'File converted successfully and report generated',
      fileName: outputFilename,
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
    console.error('Error converting file:', error);
    
    // Clean up the uploaded file in case of error (only for disk storage)
    if (!isVercel && req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
        console.log(`Deleted uploaded Excel file after error: ${req.file.path}`);
      } catch (deleteError) {
        console.error('Error deleting uploaded Excel file:', deleteError);
      }
    }
    
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to convert a specific Excel file in the directory
app.get('/convert-file', (req, res) => {
  try {
    const fileName = req.query.file;
    
    if (!fileName) {
      return res.status(400).json({ error: 'No filename provided' });
    }
    
    const filePath = path.join(__dirname, fileName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const workbook = XLSX.readFile(filePath);
    
    // Get the first sheet name
    const sheetName = workbook.SheetNames[0];
    
    // Convert sheet to JSON
    const worksheet = workbook.Sheets[sheetName];
    let jsonData = XLSX.utils.sheet_to_json(worksheet);
    
    // Filter out orders with status "Batal"
    const filteredByStatus = filterCanceledOrders(jsonData);
    
    // Filter and keep only necessary fields
    const filteredData = filterNecessaryFields(filteredByStatus);
    
    // Use standard output filename instead of original filename
    const outputFilename = 'orderData.json';
    const outputPath = path.join(__dirname, outputFilename);
    
    // Write JSON to file
    fs.writeFileSync(outputPath, JSON.stringify(filteredData, null, 2));
    
    // Automatically generate report using the newly created JSON file
    try {
      // Instead of replacing report-data.json, we'll append the data from orderData.json
      const generatedReport = generateReport(outputPath);
      
      // After generating the report, we need to merge with existing report data
      const reportDataFile = path.join(__dirname, 'public', 'report-data.json');
      
      // If report-data.json exists, we'll merge with it
      if (fs.existsSync(reportDataFile)) {
        console.log('Existing report-data.json found, merging with new data');
        
        try {
          // Read existing report data
          const existingReport = JSON.parse(fs.readFileSync(reportDataFile, 'utf8'));
          
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
          
          const mergedReport = {
            summary: {
              totalOrders: mergedOrders.length,
              totalEarnings: totalEarnings,
              averageMargin: totalSubtotal > 0 ? (totalMargin / totalSubtotal) * 100 : 0
            },
            orders: mergedOrders
          };
          
          // Save the merged report
          fs.writeFileSync(reportDataFile, JSON.stringify(mergedReport, null, 2));
          console.log(`Successfully merged data into ${reportDataFile}`);
        } catch (mergeError) {
          console.error('Error merging with existing report data:', mergeError);
          
          // If there's an error merging, just save the generated report as is
          fs.writeFileSync(reportDataFile, JSON.stringify(generatedReport, null, 2));
          console.log(`Error merging, saved generated report to ${reportDataFile}`);
        }
      } else {
        // If report-data.json doesn't exist, just save the generated report
        fs.writeFileSync(reportDataFile, JSON.stringify(generatedReport, null, 2));
        console.log(`No existing report found, saved generated report to ${reportDataFile}`);
      }
      
      console.log('Report automatically generated after file conversion');
    } catch (reportError) {
      console.error('Error generating report:', reportError);
    }
    
    res.json({ 
      success: true, 
      message: 'File converted successfully and report generated',
      fileName: outputFilename,
      totalRows: jsonData.length,
      filteredRows: filteredData.length,
      removedRows: jsonData.length - filteredByStatus.length,
      originalFileName: fileName
    });
  } catch (error) {
    console.error('Error converting file:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to save products catalog
app.post('/api/products', (req, res) => {
  try {
    const productCatalog = req.body;
    
    // Validate the data
    if (!productCatalog || !productCatalog.products) {
      return res.status(400).json({ error: 'Invalid product catalog data' });
    }
    
    // Update timestamp
    productCatalog.last_updated = new Date().toISOString();
    
    // Create backup of the existing file
    const catalogPath = path.join(__dirname, 'products-catalog.json');
    if (fs.existsSync(catalogPath)) {
      const backupPath = path.join(__dirname, `products-catalog.backup.${Date.now()}.json`);
      fs.copyFileSync(catalogPath, backupPath);
      console.log(`Backup created: ${backupPath}`);
    }
    
    // Save to file
    fs.writeFileSync(catalogPath, JSON.stringify(productCatalog, null, 2));
    console.log(`Products catalog saved: ${catalogPath}`);
    
    // Create a copy in the prodlist directory if it exists
    const prodlistDir = path.join(__dirname, 'prodlist');
    if (fs.existsSync(prodlistDir)) {
      const prodlistPath = path.join(prodlistDir, 'products-catalog.json');
      fs.writeFileSync(prodlistPath, JSON.stringify(productCatalog, null, 2));
      console.log(`Products catalog also saved to: ${prodlistPath}`);
    }
    
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

// API endpoint to list all Excel files in the directory
app.get('/files', (req, res) => {
  const files = fs.readdirSync(__dirname)
    .filter(file => file.endsWith('.xlsx') || file.endsWith('.xls'))
    .map(file => ({
      name: file,
      path: path.join(__dirname, file)
    }));
  
  res.json(files);
});

// API endpoint for manual order entry (form submission)
app.post('/manual-entry', upload.none(), (req, res) => {
  try {
    // Debug request body
    console.log('Manual entry request body keys:', Object.keys(req.body));
    
    // Parse the manual entry data from the form
    let manualData;
    
    try {
      if (!req.body.manualData) {
        console.error('Error: No manual data found in request');
        return res.status(400).json({ 
          success: false, 
          error: 'No manual data found in request'
        });
      }
      
      // Log the raw data for debugging
      console.log('Manual entry raw data (first 100 chars):', req.body.manualData.substring(0, 100) + '...');
      manualData = JSON.parse(req.body.manualData);
    } catch (parseError) {
      console.error('Error parsing manual entry data:', parseError, 'Data received:', req.body.manualData);
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid JSON data format: ' + parseError.message
      });
    }
    
    if (!manualData || !Array.isArray(manualData) || manualData.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'No valid data provided or empty array'
      });
    }
    
    // Path to the report data file (not orderData.json)
    const reportDataFile = path.join(__dirname, 'public', 'report-data.json');
    
    // Check if we should append or replace (default is replace)
    const shouldAppend = req.body.appendData === 'true';
    
    // Get the count of new records for reporting
    const newDataCount = manualData.length;
    let existingDataCount = 0;
    let duplicateCount = 0;
    
    // Process the new entries directly into the report format
    const processedEntries = [];
    
    manualData.forEach(entry => {
      try {
        // Extract data from entry
        const orderDate = entry["Waktu Pembayaran Dilakukan"];
        const orderNumber = entry["No. Pesanan"];
        const productName = entry["Nama Produk"];
        const variationName = entry["Nama Variasi"] || "";
        const quantity = parseInt(entry["Jumlah"]) || 1;
        const sellingPricePerUnit = parseFloat(entry["Harga Setelah Diskon"]) || 0;
        const mpFee = parseFloat(entry["MP Fee Manual"]) || 0;
        const voucher = parseFloat(entry["Voucher Ditanggung Penjual"]) || 0;
        
        // Get product category and base price from catalog
        const productsCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'products-catalog.json'), 'utf8'));
        
        // Find base price
        let basePrice = 0;
        const product = productsCatalog.products.find(p => 
          p.product_name === productName
        );
        
        if (product) {
          const variation = product.variations.find(v => 
            v.name === variationName
          );
          
          if (variation) {
            basePrice = variation.base_price;
          } else if (product.variations.length > 0) {
            basePrice = product.variations[0].base_price;
          }
        }
        
        // Calculate derived fields
        const totalBasePrice = basePrice * quantity;
        const subtotal = sellingPricePerUnit * quantity;
        const earnings = subtotal - mpFee - voucher;
        const margin = earnings - totalBasePrice;
        
        // Create the processed order object in the report format
        const processedEntry = {
          orderDate: new Date(orderDate),
          orderNumber,
          productName,
          variationName,
          quantity,
          basePrice,
          totalBasePrice,
          sellingPrice: sellingPricePerUnit,
          subtotal,
          mpFee,
          voucher,
          earnings,
          margin
        };
        
        processedEntries.push(processedEntry);
      } catch (error) {
        console.error(`Error processing manual entry: ${JSON.stringify(entry)}`, error);
      }
    });
    
    // Default report structure
    let updatedReport = {
      summary: {
        totalOrders: processedEntries.length,
        totalEarnings: 0,
        averageMargin: 0
      },
      orders: processedEntries
    };
    
    // If append mode and the file exists, read and merge with existing data
    if (shouldAppend && fs.existsSync(reportDataFile)) {
      try {
        // Read existing report
        const existingReportRaw = fs.readFileSync(reportDataFile);
        const existingReport = JSON.parse(existingReportRaw);
        
        // Store the count for reporting
        existingDataCount = existingReport.orders.length;
        
        // Create a map of existing order numbers for quick lookup
        const existingOrderMap = new Map();
        existingReport.orders.forEach(order => {
          // Create a unique key using order number and product name
          const key = `${order.orderNumber}-${order.productName}`;
          existingOrderMap.set(key, true);
        });
        
        // Filter out duplicates from the new data
        const uniqueNewEntries = processedEntries.filter(order => {
          const key = `${order.orderNumber}-${order.productName}`;
          const isDuplicate = existingOrderMap.has(key);
          
          if (isDuplicate) {
            duplicateCount++;
            return false;
          }
          return true;
        });
        
        // Combine the datasets
        updatedReport.orders = [...existingReport.orders, ...uniqueNewEntries];
        
        console.log(`Appending manual data: ${existingDataCount} existing records, ${uniqueNewEntries.length} new records added, ${duplicateCount} duplicates skipped`);
      } catch (err) {
        console.error('Error reading existing report data, will replace instead:', err);
        // Just use the new data if there's an error
      }
    } else {
      console.log(`Creating new report with ${processedEntries.length} manual entries`);
    }
    
    // Recalculate summary
    let totalEarnings = 0;
    let totalSubtotal = 0;
    let totalMargin = 0;
    
    updatedReport.orders.forEach(order => {
      totalEarnings += order.earnings;
      totalSubtotal += order.subtotal;
      totalMargin += order.margin;
    });
    
    updatedReport.summary = {
      totalOrders: updatedReport.orders.length,
      totalEarnings: totalEarnings,
      averageMargin: totalSubtotal > 0 ? (totalMargin / totalSubtotal) * 100 : 0
    };
    
    // Write report directly to report-data.json
    fs.writeFileSync(reportDataFile, JSON.stringify(updatedReport, null, 2));
    console.log(`Manual entry data saved directly to report-data.json with ${updatedReport.orders.length} orders`);
    
    res.json({
      success: true,
      message: shouldAppend ? 'Manual entries added successfully' : 'Manual entries saved successfully',
      totalEntries: newDataCount,
      addedEntries: shouldAppend ? newDataCount - duplicateCount : newDataCount,
      existingEntries: existingDataCount,
      duplicateSkipped: duplicateCount,
      appendMode: shouldAppend
    });
  } catch (error) {
    console.error('Error processing manual entries:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to delete specific orders by order number
app.post('/delete-orders', (req, res) => {
  try {
    console.log('Delete orders request received');
    const orderNumbers = req.body.orderNumbers;
    
    if (!orderNumbers || !Array.isArray(orderNumbers) || orderNumbers.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid order numbers provided' });
    }
    
    // Define the report data file path
    const reportDataFile = path.join(__dirname, 'public', 'report-data.json');
    
    // Check if the file exists
    if (!fs.existsSync(reportDataFile)) {
      return res.status(404).json({ success: false, error: 'Report data file not found' });
    }
    
    // Read existing data
    const reportData = JSON.parse(fs.readFileSync(reportDataFile, 'utf8'));
    
    // Make a backup of the file
    const backupFile = `${reportDataFile}.backup-${Date.now()}`;
    fs.copyFileSync(reportDataFile, backupFile);
    console.log(`Created backup at ${backupFile}`);
    
    // Filter out the orders to be deleted
    const originalCount = reportData.orders.length;
    reportData.orders = reportData.orders.filter(order => !orderNumbers.includes(order.orderNumber));
    const deletedCount = originalCount - reportData.orders.length;
    
    // Update summary info
    if (reportData.orders.length > 0) {
      const totalEarnings = reportData.orders.reduce((sum, order) => sum + order.earnings, 0);
      const totalSubtotal = reportData.orders.reduce((sum, order) => sum + order.subtotal, 0);
      const totalMargin = reportData.orders.reduce((sum, order) => sum + order.margin, 0);
      
      reportData.summary = {
        totalOrders: reportData.orders.length,
        totalEarnings: totalEarnings,
        averageMargin: totalSubtotal > 0 ? (totalMargin / totalSubtotal) * 100 : 0
      };
    }
    
    // Save the updated data
    fs.writeFileSync(reportDataFile, JSON.stringify(reportData, null, 2));
    console.log(`Successfully deleted ${deletedCount} orders`);
    
    res.json({
      success: true,
      deletedCount,
      remainingCount: reportData.orders.length
    });
  } catch (error) {
    console.error('Error deleting orders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to manually generate report from latest JSON data
app.get('/generate-report', (req, res) => {
  try {
    // Check if orderData.json exists
    const orderDataFile = path.join(__dirname, 'orderData.json');
    if (!fs.existsSync(orderDataFile)) {
      return res.status(404).json({ 
        success: false, 
        error: 'Order data file not found. Please upload an Excel file first.'
      });
    }

    // Generate report from orderData.json (this will create a new report object)
    const generatedReport = generateReport(orderDataFile);
    
    // After generating the report, we need to merge with existing report data
    const reportDataFile = path.join(__dirname, 'public', 'report-data.json');
    
    // If report-data.json exists (and it's different from what we just generated), we'll merge with it
    if (fs.existsSync(reportDataFile)) {
      console.log('Existing report-data.json found, merging with new data');
      
      try {
        // Read existing report data
        const existingReport = JSON.parse(fs.readFileSync(reportDataFile, 'utf8'));
        
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
        
        // Only merge if there are unique new orders
        if (uniqueNewOrders.length > 0) {
          // Merge orders
          const mergedOrders = [...existingReport.orders, ...uniqueNewOrders];
          
          // Recalculate summary
          const totalEarnings = mergedOrders.reduce((sum, order) => sum + order.earnings, 0);
          const totalSubtotal = mergedOrders.reduce((sum, order) => sum + order.subtotal, 0);
          const totalMargin = mergedOrders.reduce((sum, order) => sum + order.margin, 0);
          
          const mergedReport = {
            summary: {
              totalOrders: mergedOrders.length,
              totalEarnings: totalEarnings,
              averageMargin: totalSubtotal > 0 ? (totalMargin / totalSubtotal) * 100 : 0
            },
            orders: mergedOrders
          };
          
          // Save the merged report
          fs.writeFileSync(reportDataFile, JSON.stringify(mergedReport, null, 2));
          console.log(`Successfully merged data into ${reportDataFile}`);
          
          res.json({ 
            success: true, 
            message: `Report generated successfully. Added ${uniqueNewOrders.length} new orders.`,
            summary: mergedReport.summary
          });
        } else {
          // No new orders to add
          res.json({ 
            success: true, 
            message: 'No new orders to add. Report remains unchanged.',
            summary: existingReport.summary
          });
        }
      } catch (mergeError) {
        console.error('Error merging with existing report data:', mergeError);
        
        // If there's an error merging, use the generated report
        fs.writeFileSync(reportDataFile, JSON.stringify(generatedReport, null, 2));
        console.log(`Error merging, saved generated report to ${reportDataFile}`);
        
        res.json({ 
          success: true, 
          message: 'Report generated successfully (merge failed, created new report)',
          summary: generatedReport.summary
        });
      }
    } else {
      // If report-data.json doesn't exist, just save the generated report
      fs.writeFileSync(reportDataFile, JSON.stringify(generatedReport, null, 2));
      console.log(`No existing report found, saved generated report to ${reportDataFile}`);
      
      res.json({ 
        success: true, 
        message: 'Report generated successfully',
        summary: generatedReport.summary
      });
    }
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to backup report data
app.get('/backup-report', (req, res) => {
  try {
    // Path to the report data file
    const reportDataFile = path.join(__dirname, 'public', 'report-data.json');
    
    // Check if report-data.json exists
    if (!fs.existsSync(reportDataFile)) {
      return res.status(404).json({ 
        success: false, 
        error: 'Report data file not found. No data to backup.'
      });
    }

    // Create a timestamped backup file name
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const backupFile = path.join(__dirname, 'public', `report-data.backup.${timestamp}.json`);
    
    // Copy the report data to the backup file
    fs.copyFileSync(reportDataFile, backupFile);
    console.log(`Created backup of report data: ${backupFile}`);
    
    // Get backup file name without path for response
    const backupFileName = path.basename(backupFile);
    
    res.json({ 
      success: true, 
      message: 'Report data backed up successfully',
      backupFile: backupFileName
    });
  } catch (error) {
    console.error('Error backing up report data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to refresh the report data
app.get('/refresh-report', (req, res) => {
  try {
    // Check if orderData.json exists
    const orderDataPath = path.join(__dirname, 'orderData.json');
    if (!fs.existsSync(orderDataPath)) {
      return res.status(404).json({ error: 'Order data file not found' });
    }

    // Generate fresh report from order data
    const generatedReport = generateReport(orderDataPath);
    
    // Get count of orders in the generated report
    const orderCount = generatedReport.orders.length;
    
    return res.json({ 
      success: true, 
      message: 'Report refreshed successfully',
      totalOrders: orderCount
    });
  } catch (error) {
    console.error('Error refreshing report:', error);
    return res.status(500).json({ error: 'Failed to refresh report data' });
  }
});

// Serve the product catalog and fee rules directly
app.get('/products-catalog.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'products-catalog.json'));
});

app.get('/mpfeerules.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'mpfeerules.json'));
});

// Handle blob upload
app.post('/save-json-data', upload.single('jsonFile'), (req, res) => {
  console.log('Save JSON data request received');
  
  // Define the report data file path
  const reportDataFile = path.join(__dirname, 'public', 'report-data.json');
  
  if (!req.file) {
    console.error('No file uploaded');
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  try {
    let fileData;
    
    // Handle file based on storage type
    if (isVercel) {
      // For memory storage (Vercel)
      fileData = req.file.buffer.toString('utf8');
      console.log(`Read file data from buffer, length: ${fileData.length}`);
    } else {
      // For disk storage (local development)
      const filePath = req.file.path;
      console.log(`Uploaded file: ${filePath}, Size: ${req.file.size} bytes`);
      
      // Check if the file exists
      if (!fs.existsSync(filePath)) {
        console.error(`File does not exist at path: ${filePath}`);
        return res.status(500).json({ error: 'File upload failed' });
      }
      
      // Read the uploaded file
      fileData = fs.readFileSync(filePath, 'utf8');
      console.log(`Read file data, length: ${fileData.length}`);
    }
    
    console.log(`File data preview: ${fileData.substring(0, 100)}...`);
    
    // Parse JSON
    let jsonData;
    try {
      jsonData = JSON.parse(fileData);
      console.log('JSON parsed successfully');
    } catch (parseError) {
      console.error('Failed to parse JSON:', parseError);
      
      // Clean up the temp file if using disk storage
      if (!isVercel && req.file && req.file.path) {
        try { fs.unlinkSync(req.file.path); } catch (e) { console.error('Error deleting invalid file:', e); }
      }
      
      return res.status(400).json({ error: 'Invalid JSON data' });
    }
    
    // Validate that it has a proper structure with orders array and summary
    if (!jsonData.orders || !Array.isArray(jsonData.orders)) {
      console.error('Invalid data format: missing or invalid orders array');
      
      // Clean up the temp file if using disk storage
      if (!isVercel && req.file && req.file.path) {
        try { fs.unlinkSync(req.file.path); } catch (e) { console.error('Error deleting invalid file:', e); }
      }
      
      return res.status(400).json({ error: 'Invalid data format: missing or invalid orders array' });
    }
    
    // Write directly to the report data file (bypassing generateReport)
    fs.writeFileSync(reportDataFile, JSON.stringify(jsonData, null, 2));
    console.log(`Successfully saved data to ${reportDataFile}`);
    
    // Clean up the uploaded temp file if using disk storage
    if (!isVercel && req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) { console.error('Error deleting temp file:', e); }
    }
    
    res.json({ success: true, message: 'Data saved successfully' });
  } catch (error) {
    console.error('Error processing uploaded file:', error);
    
    // Clean up the temp file if using disk storage
    if (!isVercel && req.file && req.file.path) {
      try { 
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch (e) { 
        console.error('Error deleting temp file:', e); 
      }
    }
    
    res.status(500).json({ error: 'Server error processing the upload', details: error.message });
  }
});

// Diagnostic endpoint to check uploads directory
app.get('/uploads-check', (req, res) => {
  try {
    const uploadDir = path.join(__dirname, 'uploads');
    const uploadExists = fs.existsSync(uploadDir);
    
    // Try to create it if it doesn't exist
    if (!uploadExists) {
      try {
        fs.mkdirSync(uploadDir, { recursive: true });
        console.log('Created uploads directory');
      } catch (createError) {
        console.error('Error creating uploads directory:', createError);
      }
    }
    
    // Check again after attempted creation
    const dirExists = fs.existsSync(uploadDir);
    
    // Try to write a test file
    let canWrite = false;
    if (dirExists) {
      try {
        const testFile = path.join(uploadDir, 'test.txt');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        canWrite = true;
      } catch (writeError) {
        console.error('Error writing to uploads directory:', writeError);
      }
    }
    
    res.json({
      uploadDirExists: dirExists,
      canWrite: canWrite,
      dirname: __dirname,
      uploadPath: uploadDir
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Product Editor available at http://localhost:${port}/product-editor`);
}); 