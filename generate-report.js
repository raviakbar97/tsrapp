const fs = require('fs');
const path = require('path');
const { getData, COLLECTIONS } = require('./db');

// Process orders and generate report
async function generateReport(specificOrderData = null) {
  console.log(`Generating report from data`);
  
  try {
    // Get data from MongoDB instead of reading from files
    let orderData;
    if (specificOrderData) {
      // If specific order data is provided, use it directly
      orderData = specificOrderData;
    } else {
      // Otherwise, fetch from MongoDB
      orderData = await getData(COLLECTIONS.ORDERS);
      
      if (!orderData || orderData.length === 0) {
        console.error('Error: No order data found in MongoDB');
        throw new Error('Order data not found in database');
      }
    }
    
    // Get product catalog and marketplace fee rules from MongoDB
    const productsCatalog = await getData(COLLECTIONS.PRODUCTS);
    if (!productsCatalog) {
      console.error('Error: Product catalog not found in MongoDB');
      throw new Error('Product catalog not found in database');
    }
    
    const mpFeeRules = await getData(COLLECTIONS.MPFEE_RULES);
    if (!mpFeeRules) {
      console.error('Error: MP Fee rules not found in MongoDB');
      throw new Error('MP Fee rules not found in database');
    }
    
    // Get deleted orders from MongoDB
    let deletedOrderNumbers = [];
    try {
      const deletedOrdersList = await getData(COLLECTIONS.DELETED_ORDERS);
      if (Array.isArray(deletedOrdersList)) {
        deletedOrderNumbers = [...deletedOrdersList];
        console.log(`Loaded ${deletedOrderNumbers.length} permanently deleted order numbers from database`);
      }
    } catch (err) {
      console.error('Error reading deleted orders from database:', err);
    }
    
    // Check if report data exists and load it to check for deleted orders
    let existingReport;
    try {
      existingReport = await getData(COLLECTIONS.REPORT_DATA);
      
      if (existingReport && existingReport.orders) {
        // Create a map of order numbers in the existing report
        const existingOrderMap = new Map();
        existingReport.orders.forEach(order => {
          existingOrderMap.set(order.orderNumber, true);
        });
        
        // Check if certain problematic orders exist in orderData but not in report data
        // This would indicate they were manually deleted and should not be reintroduced
        const problematicOrders = ['INV/20250418/MPL/89871219236', 'INV/20250417/MPL/51453618647'];
        
        problematicOrders.forEach(orderNum => {
          // Check if this order exists in orderData
          const existsInSource = orderData.some(order => order["No. Pesanan"] === orderNum);
          // Check if this order exists in report data
          const existsInReport = existingOrderMap.has(orderNum);
          
          console.log(`Problematic order check - Order: ${orderNum}, In source: ${existsInSource}, In report: ${existsInReport}`);
          
          // If it exists in source but was removed from report, add to deleted list
          if (existsInSource && !existsInReport && !deletedOrderNumbers.includes(orderNum)) {
            console.log(`Adding ${orderNum} to deletedOrderNumbers because it was manually removed`);
            deletedOrderNumbers.push(orderNum);
          }
        });
      }
    } catch (err) {
      console.error('Error reading existing report data to check for deleted orders:', err);
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
          console.log(`Skipping order ${orderNumber} because it was manually deleted from report data`);
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
    const report = {
      generatedAt: new Date(),
      summary,
      orders: processedOrders
    };
    
    return report;
  } catch (error) {
    console.error('Error generating report:', error);
    throw error;
  }
}

module.exports = generateReport; 