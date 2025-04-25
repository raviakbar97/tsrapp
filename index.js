const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

// Import the report generation functions
const generateReport = require('./generate-report');

const app = express();
const port = 3000;

// Set up storage for uploaded files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
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

    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    
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
      generateReport(outputPath);
      console.log('Report automatically generated after file conversion');
    } catch (reportError) {
      console.error('Error generating report:', reportError);
    }
    
    // Delete the original uploaded Excel file
    try {
      fs.unlinkSync(filePath);
      console.log(`Deleted uploaded Excel file: ${filePath}`);
    } catch (deleteError) {
      console.error('Error deleting uploaded Excel file:', deleteError);
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
    
    // Clean up the uploaded file in case of error
    if (req.file && req.file.path) {
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
      generateReport(outputPath);
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
    
    // Standard output filename
    const outputFilename = 'orderData.json';
    const outputPath = path.join(__dirname, outputFilename);
    
    // Check if we should append or replace (default is replace)
    const shouldAppend = req.body.appendData === 'true';
    
    // Get the count of new records for reporting
    const newDataCount = manualData.length;
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
          const key = `${order["No. Pesanan"]}-${order["Nama Produk"]}`;
          existingOrderMap.set(key, true);
        });
        
        // Filter out duplicates from the new data
        const uniqueNewData = manualData.filter(order => {
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
        
        console.log(`Appending manual data: ${existingDataCount} existing records, ${uniqueNewData.length} new records added, ${duplicateCount} duplicates skipped`);
      } catch (err) {
        console.error('Error reading existing data, will replace instead:', err);
        finalData = manualData;
      }
    } else {
      // Replace mode - just use the new data
      finalData = manualData;
      console.log(`Replacing data with ${newDataCount} manual entries`);
    }
    
    // Write JSON to file
    fs.writeFileSync(outputPath, JSON.stringify(finalData, null, 2));
    
    // Automatically generate report using the newly created JSON file
    try {
      generateReport(outputPath);
      console.log('Report automatically generated after manual entry');
    } catch (reportError) {
      console.error('Error generating report:', reportError);
    }
    
    res.json({
      success: true,
      message: shouldAppend ? 'Manual entries added successfully' : 'Data replaced with manual entries',
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

// API endpoint to manually generate report from latest JSON data
app.get('/generate-report', (req, res) => {
  try {
    const report = generateReport();
    res.json({ 
      success: true, 
      message: 'Report generated successfully',
      summary: report.summary
    });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ success: false, error: error.message });
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
  
  if (!req.file) {
    console.error('No file uploaded');
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  console.log(`Uploaded file: ${req.file.path}, Size: ${req.file.size} bytes`);
  
  const filePath = req.file.path;
  
  // Check if the file exists
  if (!fs.existsSync(filePath)) {
    console.error(`File does not exist at path: ${filePath}`);
    return res.status(500).json({ error: 'File upload failed' });
  }
  
  try {
    // Read the uploaded file
    const fileData = fs.readFileSync(filePath, 'utf8');
    console.log(`Read file data, length: ${fileData.length}`);
    console.log(`File data preview: ${fileData.substring(0, 100)}...`);
    
    // Parse JSON
    let jsonData;
    try {
      jsonData = JSON.parse(fileData);
      console.log('JSON parsed successfully');
    } catch (parseError) {
      console.error('Failed to parse JSON:', parseError);
      // Clean up the temp file
      try { fs.unlinkSync(filePath); } catch (e) { console.error('Error deleting invalid file:', e); }
      return res.status(400).json({ error: 'Invalid JSON data' });
    }
    
    // Validate that it has a proper structure with orders array and summary
    if (!jsonData.orders || !Array.isArray(jsonData.orders)) {
      console.error('Invalid data format: missing or invalid orders array');
      // Clean up the temp file
      try { fs.unlinkSync(filePath); } catch (e) { console.error('Error deleting invalid file:', e); }
      return res.status(400).json({ error: 'Invalid data format: missing or invalid orders array' });
    }
    
    // Create backup of existing file
    const reportDataFile = path.join(__dirname, 'public', 'report-data.json');
    if (fs.existsSync(reportDataFile)) {
      const backupFile = `${reportDataFile}.backup-${Date.now()}`;
      fs.copyFileSync(reportDataFile, backupFile);
      console.log(`Created backup of existing data file: ${backupFile}`);
    }
    
    // Write directly to the report data file (bypassing generateReport)
    fs.writeFileSync(reportDataFile, JSON.stringify(jsonData, null, 2));
    console.log(`Successfully saved data to ${reportDataFile}`);
    
    // Clean up the uploaded temp file
    try { fs.unlinkSync(filePath); } catch (e) { console.error('Error deleting temp file:', e); }
    
    res.json({ success: true, message: 'Data saved successfully' });
  } catch (error) {
    console.error('Error processing uploaded file:', error);
    // Clean up the temp file if it exists
    try { 
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) { 
      console.error('Error deleting temp file:', e); 
    }
    res.status(500).json({ error: 'Server error processing the upload', details: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Product Editor available at http://localhost:${port}/product-editor`);
}); 