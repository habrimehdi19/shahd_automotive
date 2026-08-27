SHAHD AUTOMOTIVE - الروابط الثابتة

Dashboard المالك:
https://shahdautomotive-production.up.railway.app/dashboard

فضاء العمال:
https://shahdautomotive-production.up.railway.app/employee

الرابط / يحول تلقائياً إلى /dashboard.

ضع server.js وpackage.json وemployee.html داخل جذر المشروع، وpublic/index.html داخل مجلد public.
لا تحذف public/logo.jpg أو ملفات البيانات الموجودة في مشروعك.

إصلاح Login العمال - Railway:

1) يفضل إنشاء Volume في Railway وربطه بـ /data.
2) في Variables يمكن وضع:
   DATA_DIR=/data
3) إذا كان deployment جديد ومازال ما عندك حتى عامل، تقدر تنشئ أول حساب تلقائياً:
   EMPLOYEE_NAME=اسم العامل
   EMPLOYEE_LOGIN=login
   EMPLOYEE_PASSWORD=password
   EMPLOYEE_ROLE=Mécanicien
   EMPLOYEE_PHONE=رقم الهاتف (اختياري)
4) من بعد Deploy افتح:
   /employee/health
   خاص employeeCount يكون أكبر من 0 إذا كان الحساب موجود.
5) من بعد إنشاء العمال من Dashboard، الحسابات كتتحفظ في /data/employees.json إذا كان Volume مربوط.
