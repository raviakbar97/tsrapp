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

  const processedOrders = [];
  let totalEarnings = 0;
  let totalMargin = 0;
  
  orderData.forEach(order => {
    try {
      // Extract data from order
      const orderDate = order["Waktu Pembayaran Dilakukan"];
      const orderNumber = order["No. Pesanan"];
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
      const mpFee = calculateMpFee(subtotal, productCategory);
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
  
  // Create the report object
  const report = {
    summary,
    orders: processedOrders
  };
  
  // Write report to file
  fs.writeFileSync(
    path.join(__dirname, 'public', 'report-data.json'),
    JSON.stringify(report, null, 2)
  );
  
  console.log(`Report generated with ${processedOrders.length} orders.`);
  return report;
}

// Execute the report generation when file is run directly
if (require.main === module) {
  generateReport();
}

// Export the function
module.exports = generateReport; 