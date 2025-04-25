const fs = require('fs');
const path = require('path');

// Process orders and generate report
function generateReport(specificJsonFile = null) {
  // Find the most recent JSON file if none is specified, or use standard orderData.json
  const jsonFilePath = specificJsonFile || path.join(__dirname, 'orderData.json');
  
  console.log(`Generating report using data from: ${jsonFilePath}`);
  
  // Check if the file exists
  if (!fs.existsSync(jsonFilePath)) {
    console.error(`Error: File not found at ${jsonFilePath}`);
    throw new Error(`Order data file not found at ${jsonFilePath}`);
  }
  
  // Read input files
  const orderData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
  const productsCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'products-catalog.json'), 'utf8'));
  const mpFeeRules = JSON.parse(fs.readFileSync(path.join(__dirname, 'mpfeerules.json'), 'utf8'));
  
  // Check if report-data.json exists and load it to check for deleted orders
  const reportDataPath = path.join(__dirname, 'public', 'report-data.json');
  let deletedOrderNumbers = [];
  
  // Check for the deleted-orders.json file which contains permanently deleted orders
  const deletedOrdersFile = path.join(__dirname, 'deleted-orders.json');
  if (fs.existsSync(deletedOrdersFile)) {
    try {
      const deletedOrdersList = JSON.parse(fs.readFileSync(deletedOrdersFile, 'utf8'));
      if (Array.isArray(deletedOrdersList)) {
        deletedOrderNumbers = [...deletedOrdersList];
        console.log(`Loaded ${deletedOrderNumbers.length} permanently deleted order numbers from deleted-orders.json`);
      }
    } catch (err) {
      console.error('Error reading deleted-orders.json:', err);
    }
  }
  
  // Also check if report-data.json exists to catch recently deleted orders
  if (fs.existsSync(reportDataPath)) {
    try {
      // Get the existing report data to check for deleted orders
      const existingReport = JSON.parse(fs.readFileSync(reportDataPath, 'utf8'));
      
      // Create a map of order numbers in the existing report
      const existingOrderMap = new Map();
      existingReport.orders.forEach(order => {
        existingOrderMap.set(order.orderNumber, true);
      });
      
      // Check if certain problematic orders exist in orderData.json but not in report-data.json
      // This would indicate they were manually deleted and should not be reintroduced
      const problematicOrders = ['INV/20250418/MPL/89871219236', 'INV/20250417/MPL/51453618647'];
      
      problematicOrders.forEach(orderNum => {
        // Check if this order exists in orderData.json
        const existsInSource = orderData.some(order => order["No. Pesanan"] === orderNum);
        // Check if this order exists in report-data.json
        const existsInReport = existingOrderMap.has(orderNum);
        
        console.log(`Problematic order check - Order: ${orderNum}, In source: ${existsInSource}, In report: ${existsInReport}`);
        
        // If it exists in source but was removed from report, add to deleted list
        if (existsInSource && !existsInReport && !deletedOrderNumbers.includes(orderNum)) {
          console.log(`Adding ${orderNum} to deletedOrderNumbers because it was manually removed`);
          deletedOrderNumbers.push(orderNum);
        }
      });
    } catch (err) {
      console.error('Error reading existing report data to check for deleted orders:', err);
    }
  }
  
  // Normalize money values function
  function normalizeMoneyValue(value) {
    if (typeof value === 'string') {
      // Remove any non-numeric characters except dots
      const numericString = value.replace(/[^\d.]/g, '');
      // Replace dots with empty string (remove dots)
      const withoutDots = numericString.replace(/\./g, '');
      // Convert to number
      return parseFloat(withoutDots);
    }
    return value;
  }

  // Find base price from product catalog
  function findBasePrice(productName, variationName) {
    // Find the product in the catalog
    const product = productsCatalog.products.find(p => 
      p.product_name.toLowerCase() === productName.toLowerCase());
    
    if (!product) {
      console.warn(`Product not found: ${productName}`);
      return 0;
    }
    
    // Find the variation
    const variation = product.variations.find(v => 
      v.name.toLowerCase() === variationName.toLowerCase());
    
    if (!variation) {
      console.warn(`Variation not found: ${variationName} for product ${productName}`);
      return 0;
    }
    
    return variation.base_price;
  }

  // Calculate marketplace fees
  function calculateMpFee(sellingPrice, productCategory) {
    // Find the fee rules for the category
    const categoryRules = mpFeeRules.rules.find(r => r.category === productCategory);
    
    if (!categoryRules) {
      console.warn(`Category rules not found for: ${productCategory}`);
      return 0;
    }
    
    let totalFee = 0;
    
    // Apply each fee rule
    for (const rule of categoryRules.fee_rules) {
      let fee = sellingPrice * (rule.value / 100);
      
      // Apply max fee cap if exists
      if (rule.max_fee && fee > rule.max_fee) {
        fee = rule.max_fee;
      }
      
      totalFee += fee;
    }
    
    return totalFee;
  }

  // Get product category from catalog
  function getProductCategory(productName) {
    const product = productsCatalog.products.find(p => 
      p.product_name.toLowerCase() === productName.toLowerCase());
    
    if (!product) {
      console.warn(`Product not found for category lookup: ${productName}`);
      return 'A'; // Default to A if not found
    }
    
    return product.category;
  }

  // When processing orders, skip any that are in the deletedOrderNumbers list
  const processedOrders = [];
  let totalEarnings = 0;
  let totalMargin = 0;
  
  orderData.forEach(order => {
    try {
      // Extract data from order
      const orderDate = order["Waktu Pembayaran Dilakukan"];
      const orderNumber = order["No. Pesanan"];
      
      // Skip this order if it was previously deleted
      if (deletedOrderNumbers.includes(orderNumber)) {
        console.log(`Skipping order ${orderNumber} because it was manually deleted from report-data.json`);
        return;
      }
      
      const productName = order["Nama Produk"];
      const variationName = order["Nama Variasi"] || productName; // If no variation, use product name
      const quantity = normalizeMoneyValue(order["Jumlah"]);
      const sellingPricePerUnit = normalizeMoneyValue(order["Harga Setelah Diskon"]);
      const voucher = normalizeMoneyValue(order["Voucher Ditanggung Penjual"]);
      
      // Get product category and base price
      const productCategory = getProductCategory(productName);
      const basePrice = findBasePrice(productName, variationName);
      
      // Calculate derived fields
      const totalBasePrice = basePrice * quantity;
      const subtotal = sellingPricePerUnit * quantity;
      
      // Use manually entered MP fee if available, otherwise calculate it
      let mpFee;
      
      // Debug logging to troubleshoot MP Fee Manual
      console.log(`Order #${orderNumber} - MP Fee Manual:`, order["MP Fee Manual"]);
      console.log(`Order #${orderNumber} - MP Fee Manual type:`, typeof order["MP Fee Manual"]);
      
      if (order["MP Fee Manual"] !== undefined && order["MP Fee Manual"] !== null) {
        // Try to parse as number, handling various formats
        let manualFee;
        
        if (typeof order["MP Fee Manual"] === 'string') {
          // Remove any non-numeric characters except dots
          const numericString = order["MP Fee Manual"].replace(/[^\d.]/g, '');
          manualFee = parseFloat(numericString);
        } else {
          manualFee = parseFloat(order["MP Fee Manual"]);
        }
        
        // Only use if it's a valid number
        if (!isNaN(manualFee)) {
          mpFee = manualFee;
          console.log(`Order #${orderNumber} - Using manual MP Fee: ${mpFee}`);
        } else {
          mpFee = calculateMpFee(subtotal, productCategory);
          console.log(`Order #${orderNumber} - Invalid manual MP Fee, using calculated: ${mpFee}`);
        }
      } else {
        mpFee = calculateMpFee(subtotal, productCategory);
        console.log(`Order #${orderNumber} - No manual MP Fee, using calculated: ${mpFee}`);
      }
      
      const earnings = subtotal - mpFee - voucher;
      const margin = earnings - totalBasePrice;
      
      // Create the processed order object
      const processedOrder = {
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
      
      processedOrders.push(processedOrder);
      
      // Accumulate totals
      totalEarnings += earnings;
      totalMargin += margin;
    } catch (error) {
      console.error(`Error processing order: ${JSON.stringify(order)}`, error);
    }
  });
  
  // Calculate summary
  const summary = {
    totalOrders: processedOrders.length,
    totalEarnings,
    averageMargin: processedOrders.length > 0 ? (totalMargin / totalEarnings) * 100 : 0
  };
  
  // Create the final report object
  const reportObject = {
    summary,
    orders: processedOrders
  };
  
  // Return the report object without writing to file
  console.log(`Report generated with ${processedOrders.length} orders`);
  return reportObject;
}

// Execute the report generation when file is run directly
if (require.main === module) {
  const report = generateReport();
  // Write to file when run directly
  const reportFilePath = path.join(__dirname, 'public', 'report-data.json');
  fs.writeFileSync(reportFilePath, JSON.stringify(report, null, 2));
  console.log(`Report written to file: ${reportFilePath}`);
}

// Export the function
module.exports = generateReport; 