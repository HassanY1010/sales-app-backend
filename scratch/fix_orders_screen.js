const fs = require('fs');
const file = 'C:/Users/HP/Desktop/pro/sales_app/app/lib/features/orders/presentation/screens/orders_screen.dart';

let content = fs.readFileSync(file, 'utf8');

// Replace ConnectionModel instantiation
const incorrectModel = `ConnectionModel(
                            id: '',
                            requesterId: '',
                            receiverId: '',
                            status: '',
                            connectionType: '',
                            name: '',
                            createdAt: DateTime.now(),
                            updatedAt: DateTime.now(),
                          )`;

const correctModel = `ConnectionModel(
                            id: '',
                            status: '',
                            connectionType: '',
                            name: '',
                            createdAt: DateTime.now(),
                            updatedAt: DateTime.now(),
                            userId: '',
                            connectedUserId: '',
                          )`;

content = content.split(incorrectModel).join(correctModel);

// Also replace the third occurrence which is slightly differently formatted
const incorrectModel3 = `ConnectionModel(
                              id: '',
                              requesterId: '',
                              receiverId: '',
                              status: '',
                              connectionType: '',
                              name: '',
                              createdAt: DateTime.now(),
                              updatedAt: DateTime.now(),
                            )`;

const correctModel3 = `ConnectionModel(
                              id: '',
                              status: '',
                              connectionType: '',
                              name: '',
                              createdAt: DateTime.now(),
                              updatedAt: DateTime.now(),
                              userId: '',
                              connectedUserId: '',
                            )`;

content = content.split(incorrectModel3).join(correctModel3);

// Replace border in Card
content = content.replace(
  `border: Border.all(
                                color: isNearLimit ? Colors.red.withOpacity(0.3) : Colors.black.withOpacity(0.04),
                                width: isNearLimit ? 1.5 : 1,
                              ),`,
  `side: BorderSide(
                                color: isNearLimit ? Colors.red.withValues(alpha: 0.3) : Colors.black.withValues(alpha: 0.04),
                                width: isNearLimit ? 1.5 : 1,
                              ),`
);

fs.writeFileSync(file, content, 'utf8');
console.log('orders_screen.dart fixed!');
