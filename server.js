const express = require('express');
const wkx = require('wkx');
const { Client } = require('pg');
const path = require('path');
require('dotenv').config();
const { Parser } = require('json2csv');

const app = express();
const port = process.env.PORT || 3000;
const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


console.log("Connecting to database...");
client.connect()
    .then(() => console.log('Connected to PostgreSQL'))
    .catch(err => console.error('Connection error', err));

app.use(express.json());
app.use(express.static('public'));

app.use(express.static(path.join(__dirname, 'public')));

// Create new tile in the database
app.post('/api/addTile', async (req, res) => {
    try {
        const { geojson } = req.body;

        //  insert data into the noise_reports table
        await client.query(`
            INSERT INTO noise_reports (avg_db, avg_loudness, geometry)
            VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))
        `, [geojson.properties.avgdB, geojson.properties.avgLoud, JSON.stringify(geojson.geometry)]);


        // Retrieve the report_id of the inserted record
        const reportIdQuery = await client.query('SELECT lastval()');
        const reportId = reportIdQuery.rows[0].lastval;
        const dataPoint = geojson.properties;


        const firstData = dataPoint.data[0];
        let parsedTags = parseTags(firstData.tags)


        await client.query(`
    INSERT INTO noise_report_data (report_id, avg_db, max_db, device, time, date, loudness, feeling, tags)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`, [
            reportId,   // $1
            firstData.decibel.avg,      // $2
            firstData.decibel.max,      // $3 (
            firstData.decibel.device,      // $4
            firstData.time,       // $5
            firstData.date,       // $6
            firstData.loudness,   // $7
            firstData.feeling,    // $8
            parsedTags     // $9
        ]);


        res.status(201).json({ message: 'GeoJSON data added successfully' });
    } catch (error) {
        console.error('Error creating GeoJSON data:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/getTileInfo', async (req, res) => {
    try {
        const { coords } = req.body;

        // Use the WKT in the query with ST_MakeValid
        const query = `
    SELECT * 
    FROM noise_reports 
    WHERE ST_DWithin(
        ST_MakeValid(geometry),
        ST_SetSRID(ST_MakePoint($1, $2), 4326),
        0.000001
    )`;

        const tileData = (await client.query(query, [coords[0][0], coords[0][1]])).rows;

        res.json(tileData);

    } catch (error) {
        console.error('Error reading GeoJSON data:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.post('/api/getReports', async (req, res) => {
    try {
        const { id } = req.body;

        const query = `SELECT * FROM noise_report_data WHERE report_id = $1`;

        const reportData = await client.query(query, [id]);

        res.json(reportData.rows);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/api/getNumReports', async (req, res) => {
    try {
        const result = await client.query('SELECT COUNT(*) FROM noise_report_data');
        const rowCount = result.rows[0].count;
        res.json(rowCount);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Internal Server Error');
    }
});


app.get('/api/getAllReportsCSV', async (req, res) => {
    try {
        const reports = (await client.query('SELECT * FROM noise_reports')).rows;
        const data = (await client.query('SELECT * FROM noise_report_data')).rows;

        // Define fields for CSV conversion
        const fields = [
            'Tile Coordinates',
            'Average Decibel Level for Square',
            'Average Loudness (out of 5)',
            'Average Decibel Level of Reading',
            'Max Decibel Level of Reading',
            'Measurement Device',
            'Time',
            'Loudness (out of 5)',
            'Emotion (out of 5)',
            'Tags'
        ];

        // Map database response to appropriate format for CSV
        const csvData = reports.map((dbResponse) => {
            // Decode WKB (Well Known Binary) to coordinates
            const geometry = wkx.Geometry.parse(Buffer.from(dbResponse.geometry, 'hex'));
            const coordinates = geometry.toGeoJSON().coordinates;

            // Filter data for the current report_id
            const reportData = data.filter((d) => d.report_id === dbResponse.id);

            return {
                'Tile Coordinates': `${coordinates[0][0]}, ${coordinates[0][1]}`,
                'Average Decibel Level for Square': parseInt(dbResponse.avg_db),
                'Average Loudness (out of 5)': parseInt(dbResponse.avg_loudness),
                'Average Decibel Level of Reading': reportData.map((d) => parseInt(d.avg_db)).join(';'),
                'Max Decibel Level of Reading': reportData.map((d) => parseInt(d.max_db)).join(';'),
                'Measurement Device': reportData.map((d) => d.device).join(';'),
                'Date': reportData.map((d) => d.date).join(';'),
                'Time': reportData.map((d) => d.time).join(';'),
                'Loudness (out of 5)': reportData.map((d) => parseInt(d.loudness)).join(';'),
                'Emotion (out of 5)': reportData.map((d) => parseInt(d.feeling)).join(';'),
                'Tags': reportData.map((d) => parseTags(d.tags)).join(';')
            };
        });

        // Convert data to CSV format
        const parser = new Parser({ fields });
        const csv = parser.parse(csvData);

        // Set response headers for CSV download
        res.setHeader('Content-disposition', 'attachment; filename=noise_reports.csv');
        res.set('Content-Type', 'text/csv');
        res.status(200).send(csv);
    } catch (error) {
        console.error('Error generating CSV data:', error);
        res.status(500).send('Internal Server Error');
    }
});


app.get('/api/getTiles', async (req, res) => {
    try {
        const reports = (await client.query('SELECT * FROM noise_reports')).rows;
        const data = (await client.query('SELECT * FROM noise_report_data')).rows;

        const geojsonFeatures = reports.map((dbResponse) => {
            // Decode WKB (Well Known Binary) to coordinates
            const geometry = wkx.Geometry.parse(Buffer.from(dbResponse.geometry, 'hex'));
            const coordinates = geometry.toGeoJSON().coordinates;

            // Filter data for the current report_id
            const reportData = data.filter((d) => d.report_id === dbResponse.id);


            // Convert database response and reportData to GeoJSON feature for map display
            const geojsonFeature = {
                type: 'Feature',
                properties: {
                    avgdB: parseInt(dbResponse.avg_db),
                    avgLoud: parseInt(dbResponse.avg_loudness),
                    data: reportData.map((d) => ({
                        decibel: {
                            avg: parseInt(d.avg_db),
                            max: parseInt(d.max_db),
                            device: d.device,
                        },
                        time: d.time,
                        loudness: parseInt(d.loudness),
                        feeling: parseInt(d.feeling),
                        tags: parseTags(d.tags),
                    })),
                },
                geometry: {
                    type: 'Polygon',
                    coordinates,
                },
            };
            return geojsonFeature;
        });

        res.send(JSON.stringify(geojsonFeatures, null, 2));

    } catch (error) {
        console.error('Error reading GeoJSON data:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


app.listen(port, () => {
    console.log(`Server is running on port ${port} `);
});

// Update data of a specific tile
app.post('/api/updateTile', async (req, res) => {
    const { tileCoord, data } = req.body;

    try {
        // Find the tile in the noise_reports table based on coordinates
        const matchingTileQuery = await client.query(
            'SELECT id, avg_db, avg_loudness FROM noise_reports WHERE ST_DWithin(ST_MakeValid(geometry), ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.000001)',
            [tileCoord[1], tileCoord[0]]
        );


        if (matchingTileQuery.rows.length > 0) {
            const matchingTile = matchingTileQuery.rows[0];

            // Update the noise_report_data table with new data
            await client.query(`
                INSERT INTO noise_report_data(report_id, avg_db, max_db, device, time, date, loudness, feeling, tags)
            VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [
                matchingTile.id,         // $1
                data.decibel.avg,        // $2
                data.decibel.max,        // $3 
                data.decibel.max,        // $4
                data.time,               // $5
                data.date,               // $6
                data.loudness,           // $7
                data.feeling,            // $8
                ["0"],    // $9 FIX LATER
            ]);

            // Recalculate averages in the noise_reports table
            const newAveragesQuery = await client.query(`
                SELECT AVG(avg_db) AS newAvgdB, AVG(loudness) AS newAvgLoud
                FROM noise_report_data
                WHERE report_id = $1
                `, [matchingTile.id]);

            const newAvgdB = newAveragesQuery.rows[0].newavgdb;
            const newAvgLoud = newAveragesQuery.rows[0].newavgloud;

            // Update averages in the noise_reports table
            await client.query(`
                UPDATE noise_reports
                SET avg_db = $1, avg_loudness = $2
                WHERE id = $3
                `, [newAvgdB, newAvgLoud, matchingTile.id]);

            res.json({ success: true, message: 'Data updated successfully' });
        } else {
            res.status(404).json({ success: false, message: 'Tile not found' });
        }
    } catch (error) {
        console.error('Error updating tile data:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});


//parse string with commas to array
function parseTags(tagsInput) {
    try {
        // Check if the input is a string
        if (typeof tagsInput === 'string') {
            // Split the comma-separated string into an array, trim whitespaces, and remove duplicates
            const tagsArray = [...new Set(tagsInput.split(',').map(tag => tag.trim()))];
            return tagsArray;
        }
        // Check if the input is an array
        else if (Array.isArray(tagsInput)) {
            // Convert the array to a comma-separated string
            const tagsString = tagsInput.join(', ');
            // Split the comma-separated string into an array, trim whitespaces, and remove duplicates
            const tagsArray = [...new Set(tagsString.split(',').map(tag => tag.trim()))];
            return tagsArray;
        }
        // Throw an error if the input is neither a string nor an array
        else {
            throw new Error('Tags are not in string or array format');
        }
    } catch (error) {
        console.error(`Error parsing tags: ${error.message} `);
        // If there's an error, return the original input
        return tagsInput;
    }
}