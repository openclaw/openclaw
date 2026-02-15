# Invoices

| Endpoint | Description |
| --- | --- |
| GET current | Return a list of current invoices |
| [GET get/\[invoice number\]](https://developer.xero.com/documentation/api/practice-manager-3-1/invoices#get-getinvoice-number) | Detailed information for a specific invoice |
| GET draft | Return a list of draft invoices |
| [GET job/\[job number\]](https://developer.xero.com/documentation/api/practice-manager-3-1/invoices#get-jobjob-number) | Returns a list of invoices for a specific job |
| GET list | Return a list of current and archived invoices |
| [GET payments/\[invoice number\]](https://developer.xero.com/documentation/api/practice-manager-3-1/invoices#get-paymentsinvoice-number) | Return a list of payments for an invoice |

## GET current


Return a list of current invoices

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| detailed=true | Optional | Return detailed information on invoice. See GET get/\[invoice number\] method for example of detailed invoice response. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/invoice.api/current
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Invoices>
    <Invoice>
      <ID>I000123</ID>
      <InternalUUID>e873137a-7e07-49a0-8987-130e7418ad34</InternalUUID>
      <Type>Progress Invoice</Type>
      <Status>Approved</Status>   <!-- Approved, Paid, Draft, Cancelled -->
      <JobText>J000123</JobText>
      <Date>2007-09-15T00:00:00</Date>
      <DueDate>2007-09-22T00:00:00</DueDate>
      <Amount>200.00</Amount>
      <AmountTax>25.00</AmountTax>
      <AmountIncludingTax>225.00</AmountIncludingTax>
      <AmountPaid>100.00</AmountPaid>
      <AmountOutstanding>125.00</AmountOutstanding>
      <Client>
        <UUID>964b15d1-6ab0-414b-8e07-c1caa9740895</UUID>
        <Name>A C Smith Limited</Name>
      </Client>
      <Contact>
        <UUID>90597ac3-cc20-4ade-a241-4a299f3a4705</UUID>
        <Name>Andy Smith</Name>
      </Contact>
    </Invoice>
  </Invoices>
</Response>
```


## GET get/\[invoice number\]


Detailed information for a specific invoice

### Example URL

```
https://api.xero.com/practicemanager/3.1/invoice.api/get/I000123
```


### Example Job Invoice Response

```
<Response>
  <Status>OK</Status>
  <Invoice>
    <ID>I000123</ID>
    <InternalUUID>e873137a-7e07-49a0-8987-130e7418ad34</InternalUUID>
    <Type>Progress Invoice</Type>
    <Status>Approved</Status>   <!-- Approved, Paid, Draft, Cancelled -->
    <JobText>J000123</JobText>
    <Date>2007-09-15T00:00:00</Date>
    <DueDate>2007-09-22T00:00:00</DueDate>
    <Amount>200.00</Amount>
    <AmountTax>25.00</AmountTax>
    <AmountIncludingTax>225.00</AmountIncludingTax>
    <AmountPaid>100.00</AmountPaid>
    <AmountOutstanding>125.00</AmountOutstanding>
    <Client>
      <UUID>964b15d1-6ab0-414b-8e07-c1caa9740895</UUID>
      <Name>A C Smith Limited</Name>
    </Client>
    <Contact>
      <UUID>90597ac3-cc20-4ade-a241-4a299f3a4705</UUID>
      <Name>Andy Smith</Name>
    </Contact>
    <Jobs>
      <Job>
        <ID>J000345</ID>
        <Name>Brochure Design</Name>
        <Description></Description>
        <ClientOrderNumber />
        <Tasks>
          <Task>
            <UUID>bc874687-4cb4-408c-a520-5c0ef87c6d50</UUID>
            <Name>Design</Name>
            <Description></Description>
            <Minutes>60</Minutes>
            <BillableRate>150</BillableRate>
            <Billable>Yes</Billable>
            <Amount>150.00</Amount>
            <AmountTax>18.75</AmountTax>
            <AmountIncludingTax>168.75</AmountIncludingTax>
          </Task>
        </Tasks>
        <Costs>
          <Cost>
            <Description>Courier</Description>
            <Note>Note</Note>
            <Code>COURIER</Code>
            <Billable>Yes</Billable>
            <Quantity>1</Quantity>
            <UnitCost>50.00</UnitCost>
            <UnitPrice>50.00</UnitPrice>
            <Amount>50.00</Amount>
            <AmountTax>6.25</AmountTax>
            <AmountIncludingTax>56.25</AmountIncludingTax>
          </Cost>
        </Costs>
      </Job>
    </Jobs>
  </Invoice>
</Response>
```


### Example Miscellaneous Invoice Response

```
<Response>
  <Status>OK</Status>
  <Invoice>
    <ID>I000123</ID>
    <UUID>e873137a-7e07-49a0-8987-130e7418ad34</UUID>
    <Type>Miscellaneous</Type>
    <Status>Approved</Status>   <!-- Approved, Paid, Draft, Cancelled -->
    <JobText>J000123</JobText>
    <Date>2007-09-15T00:00:00</Date>
    <DueDate>2007-09-22T00:00:00</DueDate>
    <Amount>200.00</Amount>
    <AmountTax>25.00</AmountTax>
    <AmountIncludingTax>225.00</AmountIncludingTax>
    <AmountPaid>100.00</AmountPaid>
    <AmountOutstanding>125.00</AmountOutstanding>
    <Client>
      <UUID>964b15d1-6ab0-414b-8e07-c1caa9740895</UUID>
      <Name>A C Smith Limited</Name>
    </Client>
    <Contact>
      <UUID>90597ac3-cc20-4ade-a241-4a299f3a4705</UUID>
      <Name>Andy Smith</Name>
    </Contact>
    <Tasks>
      <Task>
        <UUID>bc874687-4cb4-408c-a520-5c0ef87c6d50</UUID>
        <Name>Design</Name>
        <Description></Description>
        <Minutes>60</Minutes>
        <BillableRate>150</BillableRate>
        <Billable>Yes</Billable>
        <Amount>150.00</Amount>
        <AmountTax>18.75</AmountTax>
        <AmountIncludingTax>168.75</AmountIncludingTax>
      <Task>
    </Tasks>
    <Costs>
      <Cost>
        <Description>Courier</Description>
        <Note>Note</Note>
        <Code>COURIER</Code>
        <Billable>Yes</Billable>
        <Quantity>1</Quantity>
        <UnitCost>50.00</UnitCost>
        <UnitPrice>50.00</UnitPrice>
        <Amount>50.00</Amount>
        <AmountTax>6.25</AmountTax>
        <AmountIncludingTax>56.25</AmountIncludingTax>
      <Cost>
    </Costs>
  </Invoice>
</Response>
```


## GET draft


Return a list of draft invoices

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| detailed=true | Optional | Return detailed information on invoice. See GET get/\[invoice number\] method for example of detailed invoice response. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/invoice.api/draft
```


## GET job/\[job number\]


Returns a list of invoices for a specific job

### Example URL

```
https://api.xero.com/practicemanager/3.1/invoice.api/job/J000001
```


## GET list


Return a list of current and archived invoices. The maximum date range between the from and to parameters is one year

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| from=YYYYMMDD | Required | Return invoices created on or after this date. |
| to=YYYYMMDD | Required | Return invoices created on or before this date. |
| detailed=true | Optional | Return detailed information on invoice. See GET get/\[invoice number\] method for example of detailed invoice response. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/invoice.api/list?from=20090801&to=20090901
```


## GET payments/\[invoice number\]


Return a list of payments for an invoice

### Example URL

```
https://api.xero.com/practicemanager/3.1/invoice.api/payments/I000123
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Payments>
    <Payment>
      <Date>2007-09-15T00:00:00</Date>
      <Amount>200.00</Amount>
      <Reference>ABC-f8235e1a-d383-48b7-9139-ba97ab8ca889</Reference>
    </Payment>
  </Payments>
</Response>
```
