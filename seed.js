require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');
const fs = require('fs');
const path = require('path');

const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@ac-jmjpcmv-shard-00-00.7bzasho.mongodb.net:27017,ac-jmjpcmv-shard-00-01.7bzasho.mongodb.net:27017,ac-jmjpcmv-shard-00-02.7bzasho.mongodb.net:27017/?ssl=true&replicaSet=atlas-iokm3v-shard-0&authSource=admin&appName=firstProject`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function importData() {
    try {
        console.log("Connecting to MongoDB...");
        await client.connect();
        const db = client.db("stockflow_db");

        console.log("Reading frontend JSON files...");
        const dataDir = path.join(__dirname, '../stockflow/public/data');
        
        // 1. Categories
        const categories = JSON.parse(fs.readFileSync(path.join(dataDir, 'categories.json'), 'utf-8'));
        // Mapping string 'id' to native mongo '_id' is tricky, but let's just insert them, mongo generates _id.
        // But if products link by category string ID, let's keep it simple and just insert without _id override.
        const mappedCats = categories.map(c => ({
            name: c.name,
            description: c.description,
            productCount: c.productCount,
            createdAt: new Date(c.createdAt)
        }));
        if (mappedCats.length > 0) {
           await db.collection("categories").insertMany(mappedCats);
           console.log(`Inserted ${mappedCats.length} categories.`);
        }

        // 2. Products
        const products = JSON.parse(fs.readFileSync(path.join(dataDir, 'products.json'), 'utf-8'));
        const mappedProducts = products.map(p => ({
            name: p.name,
            categoryName: p.categoryName,
            category: p.category, // string ID from previous schema
            price: p.price,
            stockQuantity: p.stock,
            minStockThreshold: p.minThreshold,
            status: p.status,
            createdAt: new Date(p.createdAt)
        }));
        if (mappedProducts.length > 0) {
           await db.collection("products").insertMany(mappedProducts);
           console.log(`Inserted ${mappedProducts.length} products.`);
        }

        // 3. Orders 
        const orders = JSON.parse(fs.readFileSync(path.join(dataDir, 'orders.json'), 'utf-8'));
        const mappedOrders = orders.map(o => ({
            customerName: o.customerName,
            totalPrice: o.totalPrice,
            status: o.status,
            date: new Date(o.createdAt),
            products: o.items.map(i => ({
                productName: i.productName,
                quantity: i.qty,
                price: i.price
            }))
        }));
        if (mappedOrders.length > 0) {
            await db.collection("orders").insertMany(mappedOrders);
            console.log(`Inserted ${mappedOrders.length} orders.`);
        }

        console.log("Successfully seeded stockflow_db!");

    } catch (err) {
        console.error("Failed to seed database", err);
    } finally {
        await client.close();
    }
}

importData();
