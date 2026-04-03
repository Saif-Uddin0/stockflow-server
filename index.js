const express = require('express')
const cors = require('cors')
require('dotenv').config();
const admin = require('firebase-admin');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const app = express();


const port = process.env.PORT || 3000


// middleware
app.use(express.json());
app.use(cors());

// Initialize Firebase Admin
try {
  admin.initializeApp();
} catch (error) {
  console.log('Firebase admin initialization error:', error.message);
}

// verifyToken Middleware for Firebase Authentication
const verifyToken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ error: true, message: 'unauthorized access' });
  }
  const token = authorization.split(' ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.decoded = decodedToken;
    next();
  } catch (error) {
    return res.status(401).send({ error: true, message: 'unauthorized access' });
  }
};


const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@ac-jmjpcmv-shard-00-00.7bzasho.mongodb.net:27017,ac-jmjpcmv-shard-00-01.7bzasho.mongodb.net:27017,ac-jmjpcmv-shard-00-02.7bzasho.mongodb.net:27017/?ssl=true&replicaSet=atlas-iokm3v-shard-0&authSource=admin&appName=firstProject`;


// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});



async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db("stockflow_db");
        // Collections
        const usersCollection = db.collection("users");
        const categoriesCollection = db.collection("categories");
        const productsCollection = db.collection("products");
        const ordersCollection = db.collection("orders");
        const restockCollection = db.collection("restock_queue");
        const activitiesCollection = db.collection("activities");

        // Helper function for Activity Logs
        const logActivity = async (action, description, userEmail = "System") => {
            const activity = {
                action,
                description,
                userEmail,
                timestamp: new Date()
            };
            await activitiesCollection.insertOne(activity);
        };

        // --- AUTH API ---
        app.post('/users', async (req, res) => {
            const user = req.body;
            const query = { email: user.email };
            const existingUser = await usersCollection.findOne(query);
            if (existingUser) {
                return res.send({ message: 'user already exists', insertedId: null });
            }
            user.createdAt = new Date();
            const result = await usersCollection.insertOne(user);
            res.send(result);
        });

        // --- CATEGORIES API ---
        app.get('/categories', verifyToken, async (req, res) => {
            const result = await categoriesCollection.find().toArray();
            res.send(result);
        });

        app.post('/categories', verifyToken, async (req, res) => {
            const category = req.body;
            category.createdAt = new Date();
            const result = await categoriesCollection.insertOne(category);
            await logActivity("Create Category", `Category "${category.name}" created.`, req.decoded?.email);
            res.send(result);
        });

        // --- PRODUCTS API ---
        app.get('/products', verifyToken, async (req, res) => {
            // Optional: Handle basic search or filters here if query params exist
            const result = await productsCollection.find().toArray();
            res.send(result);
        });

        app.post('/products', verifyToken, async (req, res) => {
            const product = req.body;
            product.stockQuantity = parseInt(product.stockQuantity) || 0;
            product.minStockThreshold = parseInt(product.minStockThreshold) || 5;
            product.status = product.stockQuantity > 0 ? 'Active' : 'Out of Stock';
            product.createdAt = new Date();
            
            const result = await productsCollection.insertOne(product);
            await logActivity("Add Product", `Product "${product.name}" added.`, req.decoded?.email);
            res.send(result);
        });

        app.put('/products/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const updatedStock = parseInt(req.body.stockQuantity);
            const product = await productsCollection.findOne({ _id: new ObjectId(id) });
            
            let status = 'Active';
            if (updatedStock === 0) status = 'Out of Stock';

            const result = await productsCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { stockQuantity: updatedStock, status: status } }
            );

            // Removing from restock queue if stock is above threshold
            if (product && updatedStock >= product.minStockThreshold) {
                 await restockCollection.deleteOne({ productId: new ObjectId(id) });
            }

            await logActivity("Restock Product", `Stock for "${product?.name}" updated to ${updatedStock}.`, req.decoded?.email);
            res.send(result);
        });


        // --- ORDER MANAGEMENT & STOCK Logic ---
        app.get('/orders', verifyToken, async (req, res) => {
            const result = await ordersCollection.find().sort({ date: -1 }).toArray();
            res.send(result);
        });

        app.post('/orders', verifyToken, async (req, res) => {
            const order = req.body; // e.g., { products: [ { productId: "...", quantity: 2 } ] }
            
            // 1. Conflict checking
            if (!order.products || order.products.length === 0) {
                return res.status(400).send({ error: true, message: "Order must contain products." });
            }

            const uniqueIds = new Set(order.products.map(p => p.productId));
            if (uniqueIds.size !== order.products.length) {
                return res.status(400).send({ error: true, message: "Duplicate products found in the order." });
            }

            let validToOrder = true;
            let errorMessage = "";
            let itemsToUpdate = [];

            // 2. Validate Stock and Availability
            for (let item of order.products) {
                const product = await productsCollection.findOne({ _id: new ObjectId(item.productId) });
                if (!product) {
                    validToOrder = false;
                    errorMessage = `Product not found.`;
                    break;
                }
                if (product.status !== 'Active') {
                    validToOrder = false;
                    errorMessage = `Product "${product.name}" is currently unavailable.`;
                    break;
                }
                if (item.quantity > product.stockQuantity) {
                    validToOrder = false;
                    errorMessage = `Only ${product.stockQuantity} items available in stock for "${product.name}".`;
                    break;
                }
                itemsToUpdate.push({ product, deductQuantity: item.quantity });
            }

            if (!validToOrder) {
                return res.status(400).send({ error: true, message: errorMessage });
            }

            // 3. Deducting stock safely
            for (let item of itemsToUpdate) {
                const newStock = item.product.stockQuantity - item.deductQuantity;
                const newStatus = newStock === 0 ? 'Out of Stock' : 'Active';

                await productsCollection.updateOne(
                    { _id: new ObjectId(item.product._id) },
                    { $set: { stockQuantity: newStock, status: newStatus } }
                );

                // Add to restock queue if threshold hit
                if (newStock < item.product.minStockThreshold) {
                    const priority = newStock === 0 ? "High" : "Medium";
                    await restockCollection.updateOne(
                        { productId: new ObjectId(item.product._id) },
                        { $set: { priority, status: "Pending", productName: item.product.name } },
                        { upsert: true }
                    );
                    await logActivity("Restock Queue", `Product "${item.product.name}" added to Restock Queue (Low Stock)`, "System");
                }
            }

            // 4. Finalize order
            order.status = 'Pending';
            order.date = new Date();
            const result = await ordersCollection.insertOne(order);

            await logActivity("Create Order", `Order ${result.insertedId} created successfully.`, req.decoded?.email);
            res.send(result);
        });

        app.put('/orders/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const updatedDoc = req.body;
            
            const result = await ordersCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { status: updatedDoc.status } }
            );

            if (result.modifiedCount > 0) {
                await logActivity("Update Order", `Order ${id} marked as ${updatedDoc.status}.`, req.decoded?.email);
            }
            res.send(result);
        });

        // --- DASHBOARD DATA ---
        app.get('/dashboard-stats', verifyToken, async (req, res) => {
            const totalOrders = await ordersCollection.countDocuments();
            const pendingOrders = await ordersCollection.countDocuments({ status: 'Pending' });
            const completedOrders = await ordersCollection.countDocuments({ status: 'Delivered' }); // Or Shipped + Delivered
            
            // Note: $expr with $getField in find logic
            // simpler count using an evaluation or fetch and count
            const allProducts = await productsCollection.find().toArray();
            const lowStockItems = allProducts.filter(p => p.stockQuantity <= p.minStockThreshold).length;

            const revenueResult = await ordersCollection.aggregate([
                { $group: { _id: null, totalRevenue: { $sum: "$totalPrice" } } }
            ]).toArray();
            const totalRevenue = revenueResult.length > 0 ? revenueResult[0].totalRevenue : 0;

            res.send({ totalOrders, pendingOrders, completedOrders, lowStockItems, totalRevenue });
        });

        // --- RESTOCK & ACTIVITIES ---
        app.get('/restock-queue', verifyToken, async (req, res) => {
            // Send back prioritized
            const result = await restockCollection.find().toArray();
            res.send(result);
        });

        app.get('/activities', verifyToken, async (req, res) => {
            const result = await activitiesCollection.find().sort({ timestamp: -1 }).limit(10).toArray();
            res.send(result);
        });

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);



app.get('/', (req, res) => {
    res.send('Something is cooking!')
})

if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Example app listening on port ${port}`)
    })
}

module.exports = app;