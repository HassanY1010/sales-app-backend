const http = require('https');

function makePost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'sales-app-backend-jhxe.onrender.com',
      port: 443,
      path: '/api/v1' + path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'User-Agent': 'NodeTestAgent'
      }
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(data);
    req.end();
  });
}

async function run() {
  console.log('--- Testing Register Endpoint on Render with ha@gmail.com ---');
  const registerPayload = {
    email: 'ha@gmail.com',
    password: 'securePassword123',
    confirmPassword: 'securePassword123',
    fullName: 'Test User',
    phoneNumber: '776461929',
    securityPin: '1234',
    userType: 'individual'
  };

  try {
    const res = await makePost('/auth/register', registerPayload);
    console.log('Status Code:', res.statusCode);
    console.log('Response Body:', res.body);
  } catch (err) {
    console.error('Error hitting register endpoint:', err);
  }
}

run();
