# Custom Fields

| Endpoint | Description |
| --- | --- |
| [GET get/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/custom-fields#get-getuuid) | Detailed information for a specific custom field |
| GET definition | Return a list of all the custom fields |
| GET customfield | Retrieve custom field data for a specific client, contact or job |
| PUT customfield | Update custom field data for a specific client, contact or job |
| PUT update | Update data for a specific custom field |
| POST add | Add a new custom field |
| POST delete | Delete a custom field |

## GET get/\[uuid\]


Detailed information for a specific custom field

### Example URL

```
https://api.xero.com/practicemanager/3.1/customfield.api/get/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <CustomFieldDefinition>
    <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
    <Name>Name of Custom Field</Name>
    <Type /> <!-- e.g. Text, Decimal, Date, Dropdown List, Value Link, etc -->
    <LinkUrl />  <!-- Optional – URL for Value Link field types -->
    <Options />  <!-- Optional – Options for Dropdown lists -->

    <!-- The following elements indicate if the field is used for clients, contacts and/or jobs -->
    <UseClient>false</UseClient>  <!-- true | false -->
    <UseContact>false</UseContact>  <!-- true | false -->
    <UseJob>false</UseJob>  <!-- true | false -->
    <UseJobTask>false</UseJobTask>  <!-- true | false -->
    <UseJobCost>false</UseJobCost>  <!-- true | false -->
    <UseJobTime>false</UseJobTime>  <!-- true | false -->
    <!-- Identifies XML element for accessing the field value during GET or PUT – valid values are: Text | Decimal | Number | Boolean | Date -->
    <ValueElement />
  </CustomFieldDefinition>
</Response>
```


## GET definition


Return a list of all the custom fields

### Example URL

```
https://api.xero.com/practicemanager/3.1/customfield.api/definition
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <CustomFieldDefinitions>
    <CustomFieldDefinition>
      <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
      <Name>Name of Custom Field</Name>
      <Type /> <!-- e.g. Text, Decimal, Date, Dropdown List, Value Link, etc -->
      <LinkUrl />  <!-- Optional – URL for Value Link field types -->
      <Options />  <!-- Optional – Options for Dropdown lists -->

      <!-- The following elements indicate if the field is used for clients, contacts and/or jobs -->
      <UseClient>false</UseClient>  <!-- true | false -->
      <UseContact>false</UseContact>  <!-- true | false -->
      <UseJob>false</UseJob>  <!-- true | false -->
      <UseJobTask>false</UseJobTask>  <!-- true | false -->
      <UseJobCost>false</UseJobCost>  <!-- true | false -->
      <UseJobTime>false</UseJobTime>  <!-- true | false -->
      <!-- Identifies XML element for accessing the field value during GET or PUT – valid values are: Text | Decimal | Number | Boolean | Date -->
      <ValueElement />
    </CustomFieldDefinition>
  </CustomFieldDefinitions>
</Response>
```


## GET customfield


Retrieve custom field data for a specific client, contact and/or job

### Example URL

Use the following URLs to retrieve custom field data:

| Type | URL |
| --- | --- |
| Client | GET [https://api.xero.com/practicemanager/3.1/client.api/get/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/client.api/get/%5C%5Bidentifier%5C%5D/customfield) |
| Client Contact | GET [https://api.xero.com/practicemanager/3.1/client.api/contact/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/client.api/contact/%5C%5Bidentifier%5C%5D/customfield) |
| Job | GET [https://api.xero.com/practicemanager/3.1/job.api/get/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/job.api/get/%5C%5Bidentifier%5C%5D/customfield) |
| Job Task | GET [https://api.xero.com/practicemanager/3.1/job.api/task/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/job.api/task/%5C%5Bidentifier%5C%5D/customfield) |
| Job Cost | GET [https://api.xero.com/practicemanager/3.1/job.api/cost/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/job.api/cost/%5C%5Bidentifier%5C%5D/customfield) |
| Time | GET [https://api.xero.com/practicemanager/3.1/time.api/get/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/time.api/get/%5C%5Bidentifier%5C%5D/customfield) |

Only custom fields containing values will be returned. If a Checkbox field does not contain a value then it is assumed to be false.

### Example Response

```
<Response>
  <Status>OK</Status>
  <CustomFields>
    <CustomField>
      <UUID>53338270-ff9a-46a5-a275-ca017ea10285</UUID>
      <Name>Date Field</Name>
      <Date>2010-10-11T00:00:00</Date>
    </CustomField>
    <CustomField>
      <UUID>b630926a-b9c8-4fd4-a931-a2c58a641de6</UUID>
      <Name>Number Field</Name>
      <Number>123</Number>
    </CustomField>
    <CustomField>
      <UUID>fc73f108-55f6-435b-9e88-bc5c952340ac</UUID>
      <Name>Decimal Field</Name>
      <Decimal>123.45</Decimal>
    </CustomField>
    <CustomField>
      <UUID>295dce11-9251-4299-8192-f55957d9a285</UUID>
      <Name>Boolean Field</Name>
      <Boolean>true</Boolean>
    </CustomField>
    <CustomField>
      <UUID>056859d4-5bcb-426e-83fd-cd615c18dfd5</UUID>
      <Name>Date Field</Name>
      <Text>some text</Text>
    </CustomField>
  </CustomFields>
</Response>
```


## PUT customfield


Update custom field data for a specific client, contact or job

### Example URL

Use the following URLs to set/update custom field data:

| Type | URL |
| --- | --- |
| Client | PUT [https://api.xero.com/practicemanager/3.1/client.api/update/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/client.api/update/%5C%5Bidentifier%5C%5D/customfield) |
| Client Contact | PUT [https://api.xero.com/practicemanager/3.1/client.api/contact/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/client.api/contact/%5C%5Bidentifier%5C%5D/customfield) |
| Job | PUT [https://api.xero.com/practicemanager/3.1/job.api/update/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/job.api/update/%5C%5Bidentifier%5C%5D/customfield) |
| Job Task | PUT [https://api.xero.com/practicemanager/3.1/job.api/task/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/job.api/task/%5C%5Bidentifier%5C%5D/customfield) |
| Job Cost | PUT [https://api.xero.com/practicemanager/3.1/job.api/cost/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/job.api/cost/%5C%5Bidentifier%5C%5D/customfield) |
| Time | PUT [https://api.xero.com/practicemanager/3.1/time.api/update/\\\[identifier\\\]/customfield](https://api.xero.com/practicemanager/3.1/time.api/update/%5C%5Bidentifier%5C%5D/customfield) |

Only custom fields containing values will be returned. If a Checkbox field does not contain a value then it is assumed to be false.

### Example Message

```
<CustomFields>
  <CustomField>
    <UUID>9fb11831-72ce-47e2-ba04-8701a5a04809</UUID>
    <Date>20101011</Date>
  </CustomField>
  <CustomField>
    <UUID>0a1dda49-db19-4913-9f26-382fc3aed04a</UUID>
    <Number>123</Number>
  </CustomField>
  <CustomField>
    <UUID>ec7fbe9c-9bd6-4c2a-b6e4-f0513bea0453</UUID>
    <Decimal>123.45</Decimal>
  </CustomField>
  <CustomField>
    <UUID>ae7e330d-a815-4f67-b8a6-be23b977e352</UUID>
    <Boolean>true</Boolean>
  </CustomField>
  <CustomField>
    <UUID>fb4ef875-39fa-46ff-a6eb-457244a60180</UUID>
    <Text>some text</Text>
  </CustomField>
</CustomFields>
```


### Example Message to clear values of custom fields

```
<CustomFields>
  <CustomField>
    <UUID>9fb11831-72ce-47e2-ba04-8701a5a04809</UUID>
    <Date />
  </CustomField>
  <CustomField>
    <UUID>0a1dda49-db19-4913-9f26-382fc3aed04a</UUID>
    <Number />
  </CustomField>
  <CustomField>
    <UUID>ec7fbe9c-9bd6-4c2a-b6e4-f0513bea0453</UUID>
    <Decimal />
  </CustomField>
  <CustomField>
    <UUID>ae7e330d-a815-4f67-b8a6-be23b977e352</UUID>
    <Text />
  </CustomField>
</CustomFields>
```


The response will be the standard API Response.

## PUT update


Update data for a specific customfield

### Example URL

```
https://api.xero.com/practicemanager/3.1/customfield.api/update
```


### Example Message

```
<CustomFieldDefinition>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
  <Name>Name of Custom Field</Name>
  <Type /> <!-- e.g. Text, Decimal, Date, Dropdown List, Value Link, etc -->
  <LinkUrl />  <!-- Optional – URL for Value Link field types -->
  <Options />  <!-- Optional – Options for Dropdown lists -->

  <!-- Optional – The following elements indicate if the field is used for clients, contacts and/or jobs -->
  <UseClient>false</UseClient>  <!-- true | false -->
  <UseContact>false</UseContact>  <!-- true | false -->
  <UseJob>false</UseJob>  <!-- true | false -->
  <UseJobTask>false</UseJobTask>  <!-- true | false -->
  <UseJobCost>false</UseJobCost>  <!-- true | false -->
  <UseJobTime>false</UseJobTime>  <!-- true | false -->
</CustomFieldDefinition>
```


## POST add


Add a new custom field

### Example URL

```
https://api.xero.com/practicemanager/3.1/customfield.api/add
```


### Example Message

```
<CustomFieldDefinition>
  <Name>Name of Custom Field</Name>
  <Type /> <!-- e.g. Text, Decimal, Date, Dropdown List, Value Link, etc -->
  <LinkUrl />  <!-- Optional – URL for Value Link field types -->
  <Options />  <!-- Optional – Options for Dropdown lists -->

  <!-- Optional – The following elements indicate if the field is used for clients, contacts and/or jobs -->
  <UseClient>false</UseClient>  <!-- true | false -->
  <UseContact>false</UseContact>  <!-- true | false -->
  <UseJob>false</UseJob>  <!-- true | false -->
  <UseJobTask>false</UseJobTask>  <!-- true | false -->
  <UseJobCost>false</UseJobCost>  <!-- true | false -->
  <UseJobTime>false</UseJobTime>  <!-- true | false -->
</CustomFieldDefinition>
```


## POST delete


Delete a custom field

### Example URL

```
https://api.xero.com/practicemanager/3.1/customfield.api/delete
```


### Example Message

```
<CustomFieldDefinition>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
</CustomFieldDefinition>
```
