# Clients

_**Note:** From the 27th of February 2023, it is recommended to use clientUuid for all Contact endpoints to avoid multi-client errors/issues. Additionally, the IsPrimary and Position properties will only be available to non-deleted Contacts that are linked to a Client. To identify non-deleted Contacts, a new IsDeleted property will be available for all Contacts._

| Endpoint | Description |
| --- | --- |
| GET list | Return a list of all clients |
| GET list paginated | Return a list of paginated clients |
| GET search | Return a list of all clients matching search query |
| [GET get/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/clients#get-getuuid) | Detailed information for a specific client |
| POST add | Create a new client and add new contacts to it |
| PUT update | Update a client's details |
| PUT archive | Archive a client |
| POST delete | Delete a client |
| GET contacts | Return a paginated subset of non-deleted contacts. |
| [GET contact/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/clients#get-contact-uuid) | Detailed information for a specific contact |
| [PUT contact/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/clients#put-contact-uuid) | Update a contact's details |
| POST contact | Create and add a new contact to a client |
| [DELETE contact/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/clients#delete-contact-uuid) | Delete a contact |
| [POST client/\[uuid\]/contacts](https://developer.xero.com/documentation/api/practice-manager-3-1/clients#post-client-uuid-contact) | Add contacts to a client |
| [GET documents/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/clients#get-documents-uuid) | Return a list of documents for a client |
| POST document | Add a document to a client |
| POST addrelationship | Add a relationship between clients (Practice Manager only) |
| PUT updaterelationship | Update the relationship details between clients (Practice Manager only) |
| POST deleterelationship | Delete the relationship between clients (Practice Manager only) |

## GET list


Return a list of all clients

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| detailed=true | Optional | Return detailed information of client. See GET get/\[identifier\] method for example of detailed client response. |
| modifiedsince=yyyy-MM-ddTHH:mm:ss | Optional | Return clients modified since a particular date (UTC), e.g. 2012-06-05T06:00:00 |

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/list
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Clients>
    <!-- Refer get/[identifier] method for full list of client fields  -->
    <Client>
      <UUID>720c21d3-e812-4bb1-9d6b-ddeb4745e7b9</UUID>
      <Name>XYZ Australia, NZ Business Unit</Name>
      <Title /> <!-- AU Tax Enabled only-->
      <Gender /> <!-- AU Tax Enabled only-->
      <FirstName /> <!-- for individuals only -->
      <LastName /> <!-- for individuals only -->
      <OtherName /> <!-- for individuals only -->
      <Email>someone@example.com</Email>
      <DateOfBirth>1970-11-26T00:00:00</DateOfBirth>
      <Address />
      <City />
      <Region />
      <PostCode />
      <Country />
      <PostalAddress>
         Level 32, PWC Building
         188 Quay Street
         Auckland Central
      </PostalAddress>
      <PostalCity>Auckland</PostalCity>
      <PostalRegion />
      <PostalPostCode>1001</PostalPostCode>
      <PostalCountry />
      <Phone>(02) 1723 5265</Phone>
      <Fax />
      <Website />
      <ReferralSource />
      <ExportCode />
      <IsArchived>No</IsArchived>
      <IsDeleted>No</IsDeleted>
      <AccountManager>
        <UUID>dc48df15-1a5c-4675-9d82-4ca54e2c6e86</UUID>
        <Name>Jo Blogs</Name>
      </AccountManager>
      <Type>
        <Name>20th of Month</Name>
        <CostMarkup>30.00</CostMarkup>
        <PaymentTerm>DayOfMonth</PaymentTerm>  <!-- DayOfMonth or WithinDays  -->
        <PaymentDay>20</PaymentDay>
      </Type>
      <Contacts>
        <Contact>
          <UUID>10e45ad9-cd3f-42b9-9e7e-056e47c0c109</UUID>
          <Name>Samantha Benecke</Name>
          <Salutation>Sam</Salutation>
          <Addressee>Mrs S Benecke</Addressee>
          <Mobile />
          <Email />
          <Phone />
          <IsDeleted>No</IsDeleted>
          <IsPrimary>Yes</IsPrimary>
          <Position />
        </Contact>
      </Contacts>
    </Client>
    <Client>
      <UUID>9e023415-b173-4375-b8d5-4220b5a6b294</UUID>
      <Name>A. Dutchess</Name>
      <Address />
      <City />
      <Region />
      <PostCode />
      <Country />
      <PostalAddress>P O Box 123</PostalAddress>
      <PostalCity>Wellington</PostalCity>
      <PostalRegion />
      <PostalPostCode>6011</PostalPostCode>
      <PostalCountry />
      <Phone />
      <Fax />
      <Website />
      <Contacts />
      <BillingClient>
        <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
        <Name>Billing Client</Name>
      </BillingClient>
    </Client>
  </Clients>
</Response>
```


## GET list paginated


Return a paginated subset of non-archived and non-deleted clients.

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| pageSize | Optional | Specifies the number of clients per page. Defaults to 50. Between 1 and 500. |
| pageToken | Optional | Auto-generated continuation token for navigating paginated results. Used to represent the current page of results. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/paged-list?pageToken={nextToken}&pageSize={int}
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Clients>
    <!-- Refer get/[identifier] method for full list of client fields -->
    <Client>
      <UUID>78f4dd4c-6c38-4f3b-b04b-47a0b3a1</UUID>
      <Name>XYZ Australia, NZ Business Unit</Name>
      <Title /> <!-- AU Tax Enabled only -->
      <Gender /> <!-- AU Tax Enabled only -->
      <FirstName /> <!-- for individuals only -->
      <LastName /> <!-- for individuals only -->
      <OtherName /> <!-- for individuals only -->
      <Email>someone@example.com</Email>
      <DateOfBirth>1970-11-26T00:00:00</DateOfBirth>
      <Address />
      <City />
      <Region />
      <PostCode />
      <Country />
      <PostalAddress>
        Level 32, PWC Building
        188 Quay Street
        Auckland Central
      </PostalAddress>
      <PostalCity>Auckland</PostalCity>
      <PostalRegion />
      <PostalPostCode>1001</PostalPostCode>
      <PostalCountry />
      <Phone>(02) 1723 5265</Phone>
      <Fax />
      <Website />
      <ReferralSource />
      <ExportCode />
      <IsArchived>No</IsArchived>
      <IsDeleted>No</IsDeleted>
      <AccountManager>
        <UUID>df782110-f532-44e5-b605-1c3bd50c30af</UUID>
        <Name>Jo Blogs</Name>
      </AccountManager>
      <Type>
        <Name>20th of Month</Name>
        <CostMarkup>30.00</CostMarkup>
        <PaymentTerm>DayOfMonth</PaymentTerm> <!-- DayOfMonth or WithinDays -->
        <PaymentDay>20</PaymentDay>
      </Type>
    </Client>
    <Client>
      <UUID>bee53537-6e0d-40a1-8b41-ca9d4f2ca473</UUID>
      <Name>A. Dutchess</Name>
      <Address />
      <City />
      <Region />
      <PostCode />
      <Country />
      <PostalAddress>P O Box 123</PostalAddress>
      <PostalCity>Wellington</PostalCity>
      <PostalRegion />
      <PostalPostCode>6011</PostalPostCode>
      <PostalCountry />
      <Phone />
      <Fax />
      <Website />
      <BillingClient>
        <UUID>bee53537-6e0d-40a1-8b41-ca9d4f2ca473</UUID>
        <Name>Billing Client</Name>
      </BillingClient>
    </Client>
  </Clients>
  <Pagination>
    <Links>
      <First>https://api.xero.com/practicemanager/3.1/client.api/paged-list?pageSize=10</First>
      <Next>https://api.xero.com/practicemanager/3.1/client.api/paged-list?pageToken=bGlnaHQgd29y&pageSize=10</Next>
    </Links>
  </Pagination>
</Response>
```


## GET search


Return a list of all clients matching search query

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| detailed=true | Optional | Return detailed information of client. See GET get/\[identifier\] method for example of detailed client response. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/search?query=XYZ
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Clients>
    <Client>
      <UUID>12bd4f61-d676-40b7-afa6-d9acb476fdc9</UUID>
      <Name>XYZ Australia, NZ Business Unit</Name>
      <Email>someone@example.com</Email>
      <DateOfBirth>1970-11-26</DateOfBirth>
      <Address />
      <City />
      <Region />
      <PostCode />
      <Country />
      <PostalAddress>
         Level 32, PWC Building
         188 Quay Street
         Auckland Central
      </PostalAddress>
      <PostalCity>Auckland</PostalCity>
      <PostalRegion />
      <PostalPostCode>1001</PostalPostCode>
      <PostalCountry />
      <Phone>(02) 1723 5265</Phone>
      <Fax />
      <Website />
      <ReferralSource />
      <ExportCode />
      <AccountManager>
        <UUID>dc48df15-1a5c-4675-9d82-4ca54e2c6e86</UUID>
        <Name>Jo Blogs</Name>
      </AccountManager>
      <Type>
        <Name>20th of Month</Name>
        <CostMarkup>30.00</CostMarkup>
        <PaymentTerm>DayOfMonth</PaymentTerm>  <!-- DayOfMonth or WithinDays  -->
        <PaymentDay>20</PaymentDay>
      </Type>
      <Contacts>
        <Contact>
          <UUID>261b486a-923b-4643-a7ef-1167d7ccfd68</UUID>
          <Name>Samantha Benecke</Name>
          <Salutation>Sam</Salutation>
          <Addressee>Mrs S Benecke</Addressee>
          <Mobile />
          <Email />
          <Phone />
          <IsDeleted>No</IsDeleted>
          <IsPrimary>Yes</IsPrimary>
          <Position />
        </Contact>
      </Contacts>
    </Client>
    <Client>
      <UUID>af162e7e-c9f2-4fc6-906c-34afafec5d15</UUID>
      <Name>XYZ Dutchess</Name>
      <Address />
      <City />
      <Region />
      <PostCode />
      <Country />
      <PostalAddress>P O Box 123</PostalAddress>
      <PostalCity>Wellington</PostalCity>
      <PostalRegion />
      <PostalPostCode>6011</PostalPostCode>
      <PostalCountry />
      <Phone />
      <Fax />
      <Website />
      <Contacts />
      <BillingClient />
    </Client>
  </Clients>
</Response>
```


## GET get/\[uuid\]


Detailed information for a specific client

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/get/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <WebUrl>https://practicemanager.xero.com/Client/123/Detail</WebUrl>
  <Client>
    <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
    <Name>Acmer Pty Ltd</Name>
    <Email>someone@example.com</Email>
    <DateOfBirth>1970-11-26</DateOfBirth>
    <Address />
    <City />
    <Region />
    <PostCode />
    <Country />
    <PostalAddress>
       Level 32, PWC Building
       188 Quay Street
       Auckland Central
    </PostalAddress>
    <PostalCity>Auckland</PostalCity>
    <PostalRegion />
    <PostalPostCode>1001</PostalPostCode>
    <PostalCountry />
    <Phone>(02) 1723 5265</Phone>
    <Fax />
    <Website />
    <ReferralSource />
    <ExportCode />
    <AccountManager>
      <UUID>dc48df15-1a5c-4675-9d82-4ca54e2c6e86</UUID>
      <Name>Jo Blogs</Name>
    </AccountManager>
    <Type>
      <Name>20th of Month</Name>
      <CostMarkup>30.00</CostMarkup>
      <PaymentTerm>DayOfMonth</PaymentTerm>  <!-- DayOfMonth or WithinDays  -->
      <PaymentDay>20</PaymentDay>
    </Type>
    <Contacts>
      <Contact>
        <UUID>dd92bcf4-4227-447a-a0d9-81984609aa5e</UUID>
        <Name>Wyett E Coyote</Name>
        <Salutation />
        <Addressee />
        <Mobile />
        <Email />
        <Phone />
        <IsDeleted>No</IsDeleted>
        <IsPrimary>Yes</IsPrimary>
        <Position />
      </Contact>
    </Contacts>
     <Notes>
      <Note>
        <Title>note title</Title>
        <Text>subject of the note</Text>
        <Folder />
        <Date>2008-09-12T13:00:00</Date>
        <CreatedBy>Jo Bloggs</CreatedBy>
      </Note>
    </Notes>
    <BillingClient>
      <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
      <Name>Billing Client</Name>
    </BillingClient>

    <!-- The following fields are returned if the Practice Management module is enabled -->

    <JobManager>
      <UUID>98466a19-16df-4ded-b657-0a80ef9a2094</UUID>
      <Name>John Smith</Name>
    </JobManager>
    <FirstName />  <!-- Individual Only -->
    <LastName />   <!-- Individual Only -->
    <OtherName />  <!-- Individual Only -->
    <DateOfBirth />  <!-- Individual Only -->

    <TaxNumber />   ******123  <!-- e.g. where the tax number is masked with *** except last 3 digits -->
    <CompanyNumber />
    <BusinessNumber />
    <BusinessStructure />   <!-- e.g. Individual, Company, Trust, etc  -->
    <BalanceMonth />
    <PrepareGST />   <!-- Yes or No -->
    <GSTRegistered />   <!-- Yes or No -->
    <GSTPeriod />  <!-- Monthly, 2 Monthly, 6 Monthly  -->
    <GSTBasis />  <!-- Invoice, Payment, Hybrid  -->
    <ProvisionalTaxBasis />  <!-- Standard Option, Estimate Option, Ratio Option  -->
    <ProvisionalTaxRatio />
    <!-- The following fields apply to NZ clients only -->
    <SignedTaxAuthority />  <!-- Yes or No -->
    <TaxAgent />
    <AgencyStatus />  <!-- With EOT, Without EOT, Unlinked -->
    <ReturnType />  <!-- IR3, IR3NR, IR4, IR6, IR7, IR9, PTS  -->

    <!-- The following fields apply to AU clients only -->
    <PrepareActivityStatement />  <!-- Yes or No -->
    <PrepareTaxReturn />  <!-- Yes or No -->

    <Groups>
      <Group>
        <UUID>0dd913a9-6c7b-4060-ac4b-6ff7b41bd233</UUID>
        <Name>Bloggs Family</Name>
      </Group>
    </Groups>

    <Relationships>
      <Relationship>
        <UUID>1d44f4b8-094f-4b91-a73e-b00b83593f71</UUID>
        <Type>Shareholder</Type>
        <RelatedClient>
          <UUID>7b57ae35-244b-4ded-b237-b3ea8a222dd2</UUID>
          <Name>Bloggs Ltd</Name>
        </RelatedClient>
        <NumberOfShares>1000</NumberOfShares>  <!-- Only set for Shareholder and Owner relationships -->
        <Percentage>0</Percentage>  <!-- Only set for Partnership relationships-->
        <StartDate>2011-01-01</StartDate>
        <EndDate>2013-03-31</EndDate>
      </Relationship>
    </Relationships>

  </Client>
</Response>
```


## POST add


Create a new client and add new contacts to it

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/add
```


### Example Message

```
<Client>
  <Name>Bloggs Electrical Ltd</Name> <!-- Display Name -->
  <Email></Email>  <!-- optional -->
  <Address></Address>  <!-- optional -->
  <City></City>  <!-- optional -->
  <Region></Region>  <!-- optional -->
  <PostCode></PostCode>  <!-- optional -->
  <Country></Country>  <!-- optional -->
  <PostalAddress></PostalAddress>  <!-- optional -->
  <PostalCity></PostalCity>  <!-- optional -->
  <PostalRegion></PostalRegion>  <!-- optional -->
  <PostalPostCode></PostalPostCode>  <!-- optional -->
  <PostalCountry></PostalCountry>  <!-- optional -->
  <Phone></Phone>  <!-- optional -->
  <Fax></Fax>  <!-- optional -->
  <WebSite></WebSite>  <!-- optional -->
  <ReferralSource></ReferralSource>  <!-- optional -->
  <ExportCode></ExportCode>  <!-- optional -->
  <AccountManagerUUID />  <!-- optional – UUID of staff member -->
  <Contacts>
    <Contact>
      <Name>Jo Bloggs</Name>
      <IsPrimary>Yes</IsPrimary> <!-- If multiple contacts defined, method will interpret last primary client as Primary -->
      <Salutation></Salutation>  <!-- optional -->
      <Addressee></Addressee>  <!-- optional -->
      <Phone></Phone>  <!-- optional -->
      <Mobile></Mobile>  <!-- optional -->
      <Email></Email>  <!-- optional -->
      <Position></Position>  <!-- optional -->
    </Contact>
  </Contacts>
  <BillingClientUUID /> <!-- optional ID of billing client -->
  <!-- The following fields are only applicable if the Practice Management module is enabled -->

  <FirstName />   <!-- Optional, for individuals only. Legal First Name used for tax purposes. -->
  <LastName />   <!-- Optional, for individuals only. Legal Last Name used for tax purposes. -->
  <OtherName />   <!-- optional, for individuals only -->
  <DateOfBirth />   <!-- optional, for individuals only -->

  <JobManagerUUID />  <!-- optional – UUID of staff member -->
  <TaxNumber />
  <CompanyNumber />
  <BusinessNumber />
  <BusinessStructure />   <!-- Name of Business Structure (as per Admin) -->
  <BalanceMonth />  <!-- e.g. Jan, 1, Feb, 2, Mar, 3 etc  -->
  <PrepareGST />   <!-- Yes or No -->
  <GSTRegistered />   <!-- Yes or No -->
  <GSTPeriod />  <!-- 1, 2, 6 -->
  <GSTBasis />  <!-- Invoice, Payment, Hybrid  -->
  <ProvisionalTaxBasis />  <!-- Standard Option, Estimate Option, Ratio Option  -->
  <ProvisionalTaxRatio />

  <!-- The following fields apply to NZ clients only -->
  <SignedTaxAuthority />  <!-- Yes or No -->
  <TaxAgent />  <!-- Name of Tax Agent (as per Admin) -->
  <AgencyStatus />  <!-- With EOT, Without EOT, Unlinked -->
  <ReturnType />  <!-- IR3, IR3NR, IR4, IR6, IR7, IR9, PTS  -->

  <!-- The following fields apply to AU clients only -->
  <PrepareActivityStatement />  <!-- Yes or No -->
  <PrepareTaxReturn />  <!-- Yes or No -->

</Client>
```


The response will include the detailed information of the client as per the GET get/\[identifier\] method

## PUT update


Update a client's details

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/update
```


### Example Message

```
<Client>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
  <Name>Bloggs Electrical Ltd</Name> <!-- Display Name -->
  <Email></Email>  <!-- optional -->
  <Address></Address>  <!-- optional -->
  <City></City>  <!-- optional -->
  <Region></Region>  <!-- optional -->
  <PostCode></PostCode>  <!-- optional -->
  <Country></Country>  <!-- optional -->
  <PostalAddress></PostalAddress>  <!-- optional -->
  <PostalCity></PostalCity>  <!-- optional -->
  <PostalRegion></PostalRegion>  <!-- optional -->
  <PostalPostCode></PostalPostCode>  <!-- optional -->
  <PostalCountry></PostalCountry>  <!-- optional -->
  <Phone></Phone>  <!-- optional -->
  <Fax></Fax>  <!-- optional -->
  <WebSite></WebSite>  <!-- optional -->
  <ReferralSource></ReferralSource>  <!-- optional -->

  <AccountManagerUUID />  <!-- optional – UUID of staff member -->
  <BillingClientUUID /> <!-- optional UUID of billing client -->
  <!-- The following fields are only applicable if the Practice Management module is enabled -->

  <FirstName />   <!-- Optional, for individuals only. Legal First Name used for tax purposes. -->
  <LastName />   <!-- Optional, for individuals only. Legal Last Name used for tax purposes. -->
  <OtherName />   <!-- optional, for individuals only -->
  <DateOfBirth />   <!-- optional, for individuals only -->

  <JobManagerUUID />  <!-- optional – UUID of staff member -->
  <TaxNumber />
  <CompanyNumber />
  <BusinessNumber />
  <BusinessStructure />   <!-- Name of Business Structure (as per Admin) -->
  <BalanceMonth />  <!-- e.g. Jan, 1, Feb, 2, Mar, 3 etc  -->
  <PrepareGST />   <!-- Yes or No -->
  <GSTRegistered />   <!-- Yes or No -->
  <GSTPeriod />  <!-- 1, 2, 6 -->
  <GSTBasis />  <!-- Invoice, Payment, Hybrid  -->
  <ProvisionalTaxBasis />  <!-- Standard Option, Estimate Option, Ratio Option  -->
  <ProvisionalTaxRatio />

  <!-- The following fields apply to NZ clients only -->
  <SignedTaxAuthority />  <!-- Yes or No -->
  <TaxAgent />  <!-- Name of Tax Agent (as per Admin) -->
  <AgencyStatus />  <!-- With EOT, Without EOT, Unlinked -->
  <ReturnType />  <!-- IR3, IR3NR, IR4, IR6, IR7, IR9, PTS  -->

  <!-- The following fields apply to AU clients only -->
  <PrepareActivityStatement />  <!-- Yes or No -->
  <PrepareTaxReturn />  <!-- Yes or No -->
</Client>
```


The response will include the detailed information of the client as per the GET get/\[identifier\] method

## PUT archive


Archive a client

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/archive
```


### Example Message

```
<Client>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
</Client>
```


The response will include the detailed information of the client as per the GET get/\[identifier\] method

## POST delete


Delete a client

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/delete
```


### Example Message

```
<Client>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
</Client>
```


## GET contacts


Return a paginated subset of non-deleted contacts.

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| pageSize | Optional | Maximum number of contacts to return. Defaults to 50. Between 1 and 500. |
| pageToken | Optional | Auto-generated continuation token. Used to represent the current page of results. |

### EXAMPLE URL

```
https://api.xero.com/practicemanager/3.0/client.api/contacts?pageSize=10
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Contacts>
    <Contact>
      <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
      <Name>Wyett E Coyote</Name>
      <Salutation />
      <Addressee />
      <Mobile />
      <Email />
      <Phone />
      <IsDeleted>No</IsDeleted>
    </Contact>
  </Contacts>
  <Pagination>
    <Links>
      <First>https://api.xero.com/practicemanager/3.1/client.api/contacts?pageSize=10</First>
      <Next>https://api.xero.com/practicemanager/3.1/client.api/contacts?pageSize=10&pageToken=bGlnaHQgd29y</Next>
    </Links>
  </Pagination>
</Response>
```


## GET contact/\[uuid\]


Detailed information for a specific contact

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| clientUuid | Optional | Return full details of Contact in relation to the client. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/contact/f8235e1a-d383-48b7-9139-ba97ab8ca889?clientUuid=50539fbc-d8e2-4943-bece-313a22489bb8
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Contact>
    <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
    <Name>Wyett E Coyote</Name>
    <Salutation />
    <Addressee />
    <Mobile />
    <Email />
    <Phone />
    <IsDeleted>No</IsDeleted>
    <!-- clientUuid must be provided to guarantee that Position and IsPrimary are returned. -->
    <IsPrimary>Yes</IsPrimary>
    <Position />
  </Contact>
</Response>
```


The response will include the detailed information of the contact as per the GET contact/\[identifier\] method

## PUT contact/\[uuid\]


Update a contacts details

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/contact/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


### Example Message

```
<Contact>
  <Name>Wyett E Coyote</Name>
  <Salutation />
  <Addressee />
  <Mobile />
  <Email />
  <Phone />
  <!-- Position and IsPrimary can only be updated for a Contact linked to an existing Client.-->
  <Client>
    <UUID>50539fbc-d8e2-4943-bece-313a22489bb8</UUID>
  </Client>
  <Position />
  <IsPrimary>Yes</IsPrimary>
</Contact>
```


## POST contact


Create a new contact and add it to a client

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/contact
```


### Example Message

```
<Contact>
  <Client>
    <UUID>50539fbc-d8e2-4943-bece-313a22489bb8</UUID> <!-- Required. -->
  </Client>
  <Name>Wyett E Coyote</Name>
  <Salutation />
  <Addressee />
  <Mobile />
  <Email />
  <Phone />
  <Position />
  <IsPrimary>Yes</IsPrimary>
</Contact>
```


## DELETE contact/\[uuid\]


Delete a contact

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| clientUuid | Optional | Allow delete of contact from selected client. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/contact/f8235e1a-d383-48b7-9139-ba97ab8ca889?clientUuid=50539fbc-d8e2-4943-bece-313a22489bb8
```


## POST client/\[uuid\]/contacts


Add contacts to a client. Up to 10 contacts can be added to a client per request.

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/client/f8235e1a-d383-48b7-9139-ba97ab8ca889/contacts
```


### Example Message

```
<Client>
  <Contacts>
    <Contact>
      <UUID>AB6C4656-C69F-4993-A7C1-B87461B85FF4</UUID> <!-- Required. -->
      <Position />
      <IsPrimary>No</IsPrimary>
    </Contact>
    <Contact>
      <UUID>273F166A-9DD1-4B62-B2C2-D875AC8745E1</UUID> <!-- Required. -->
      <Position />
      <IsPrimary>Yes</IsPrimary>
    </Contact>
  </Contacts>
</Client>
```


## GET documents/\[uuid\]


Return a list of documents for a client

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/documents/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


### Example Message

```
<Documents>
  <Document>
    <Title>Document Title</Title>
    <Text />    <!-- optional -->
    <Folder>Correspondence</Folder>    <!-- optional -->
    <Date>20091023</Date>
    <CreatedBy>Jo Bloggs</CreatedBy>
    <URL>https://practicemanager.xero.com/....... </URL>
  </Document>
</Documents>
```


## POST document


Add a document to a client

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/document
```


### Example Message

```
<Document>
  <ClientUUID>94bfb8c1-d8f8-4457-84c5-d978a0d71de9</ClientUUID>
  <Title>Document Title</Title>
  <Text>The note relating to the document</Text>
  <Folder>Images</Folder>    <!-- optional -->
  <FileName>example.jpg</FileName>
  <Content>File content base 64 encoded</Content>
</Document>
```


## POST addrelationship


Add a relationship between clients (Practice Manager only)

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/addrelationship
```


### Example Message

```
<Relationship>
  <ClientUUID>94bfb8c1-d8f8-4457-84c5-d978a0d71de9</ClientUUID>
  <RelatedClientUUID>38794f37-2bbd-4906-84ad-1693df5cc3ad</RelatedClientUUID>
  <Type>Shareholder</Type>
  <!-- The following relationship types are supported: Director, Shareholder, Trustee, Beneficiary, Partner, Settlor, Associate, Secretary, Public Officer, Husband, Wife, Spouse, Parent Of, Child Of, Appointer, Member, Auditor, Owner. -->
  <NumberOfShares>1000</NumberOfShares>  <!-- only applicable when adding Shareholder or Owner relationship -->
  <Percentage>25</Percentange>  <!-- only applicable when adding Partnership relationship -->
  <StartDate />  <!-- optional yyyy-MM-dd -->
  <EndDate />  <!-- optional yyyy-MM-dd -->
</Relationship>
```


## PUT updaterelationship


Update the relationship details between clients (Practice Manager only)

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/updaterelationship
```


### Example Message

```
<Relationship>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
  <NumberOfShares>1000</NumberOfShares>  <!-- only applicable when Shareholder or Owner relationship -->
  <Percentage>30</Percentange>  <!-- only applicable when adding Partnership relationship -->
  <StartDate />  <!-- optional yyyy-MM-dd -->
  <EndDate />  <!-- optional yyyy-MM-dd -->
</Relationship>
```


## POST deleterelationship


Delete the relationship between clients (Practice Manager only)

### Example URL

```
https://api.xero.com/practicemanager/3.1/client.api/deleterelationship
```


### Example Message

```
<Relationship>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
</Relationship>
```
