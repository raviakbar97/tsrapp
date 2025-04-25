# Teh Solo Racikan Sales Dashboard

A web application for managing sales data, generating reports, and analyzing business performance metrics.

## Features

- **Sales Data Management**: Upload Excel sales data or manually enter data
- **Simple Editor**: Edit and delete entries directly in the report data
- **Sales Dashboard**: View key performance metrics and sales analytics
- **Product Catalog Management**: Manage product details and base pricing
- **Efficient Storage**: Uploaded Excel files are automatically deleted after processing to save space

## Deployment on Vercel

This application is optimized for deployment on Vercel.

### Prerequisites

- A Vercel account
- Git installed on your local machine

### Deployment Steps

1. Push your code to a Git repository (GitHub, GitLab, or Bitbucket)

2. Connect your Vercel account to your repository:
   - Log in to Vercel
   - Click "New Project"
   - Import your repository
   - Select the appropriate repository

3. Configure deployment settings:
   - Framework Preset: Other
   - Root Directory: ./ (default)
   - Build Command: None (default)
   - Output Directory: None (default)
   - Install Command: npm install

4. Click "Deploy"

### Environment Variables

No environment variables are required for basic functionality.

## Local Development

1. Clone the repository
   ```
   git clone [your-repository-url]
   ```

2. Install dependencies
   ```
   npm install
   ```

3. Start the server
   ```
   npm run dev
   ```

4. Open `http://localhost:3000` in your browser

## File Structure

- `index.js` - Main Express application server
- `generate-report.js` - Report generation logic
- `products-catalog.json` - Product database
- `mpfeerules.json` - Marketplace fee calculation rules
- `public/` - Frontend HTML, CSS, and client-side JavaScript
- `uploads/` - Temporary storage for uploaded Excel files

## Excel to JSON Converter

A simple application to convert Excel (.xlsx) files to JSON format.

### Features

- Web interface for uploading and converting Excel files
- API endpoints for programmatic conversion
- Command-line interface for quick conversion
- Auto-detection of Excel files in the directory
- **Filtering**: Automatically removes orders with "status Pesanan": "Batal" from the output JSON

### Installation

1. Make sure you have Node.js installed on your system (v12 or higher recommended)
2. Clone or download this repository
3. Navigate to the project directory
4. Install dependencies:

```
npm install
```

### Usage

#### Web Interface

1. Start the server:

```
npm start
```

2. Open your browser and navigate to http://localhost:3000
3. Use the web interface to upload and convert Excel files
4. The application will automatically filter out canceled orders ("status Pesanan": "Batal")

#### Command Line Interface

To convert an Excel file directly from the command line:

```
node convert-cli.js "path/to/your/excel-file.xlsx"
```

If you run the command without arguments, it will list all available Excel files in the current directory:

```
node convert-cli.js
```

#### API Endpoints

- `GET /files` - Lists all Excel files in the directory
- `GET /convert-file?file=filename.xlsx` - Converts a specific Excel file to JSON
- `POST /convert` - Upload and convert an Excel file (multipart/form-data with 'excelFile' field)

### Example

If you have an Excel file named `Order.all.20250325_20250424 (1).xlsx`, you can convert it to JSON using:

```
node convert-cli.js "Order.all.20250325_20250424 (1).xlsx"
```

This will create a JSON file with the same name: `Order.all.20250325_20250424 (1).json`

The conversion process will:
1. Convert the Excel data to JSON
2. Filter out any orders with status "Batal" (canceled)
3. Save only the non-canceled orders to the JSON file 