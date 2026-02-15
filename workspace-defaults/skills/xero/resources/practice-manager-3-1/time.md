# Time

| Endpoint | Description |
| --- | --- |
| [GET job/\[job number\]](https://developer.xero.com/documentation/api/practice-manager-3-1/time#get-jobjob-number) | Returns a list of time sheet entries for a specific job |
| GET list | Return a list of time sheet entries |
| [GET staff/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/time#get-staffuuid) | Return a list of time sheet entries for a specific staff member |
| [GET get/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/time#get-getuuid) | Detailed information for a specific time entry |
| POST add | Add a time sheet entry to a job |
| PUT update | Update a time sheet entry on a job |
| [DELETE delete/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/time#delete-deleteuuid) | Delete a specific time sheet entry |

## GET job/\[job number\]


Returns a list of time sheet entries for a specific job

### Example URL

```
https://api.xero.com/practicemanager/3.1/time.api/job/J000001?from=20090801&to=20090901
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Times>
    <Time>
      <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
      <Job>
        <ID>J000001</ID>
        <Name>Brochure Template</Name>
      </Job>
      <Task>
        <UUID>faabafbe-1a8c-4172-b4a5-d989dda44ab5</UUID>
        <Name>Design &amp; Layout</Name>
      </Task>
      <Staff>
        <UUID>c2014300-12a3-4d98-9b83-0ff84ae1c72b</UUID>
        <Name>Chris Spence</Name>
      </Staff>
      <Date>2008-10-29T00:00:00</Date>
      <Minutes>240</Minutes>
      <Note />
      <Billable>true</Billable>
      <!-- below values are included if the time entry was record with a start and end time -->
      <Start>13:00</Start>
      <End>17:00</End>
      <InvoiceTaskUUID /> <!-- if time was invoiced -->
    </Time>
    <Time>
      <UUID>17cea522-77a8-4b38-912a-7bc6f6c6eca9</UUID>
      <Job>
        <ID>J000001</ID>
        <Name>Brochure Template</Name>
      </Job>
      <Task>
        <UUID>378300a7-dcb3-43ba-901d-d40c1fe14ba9</UUID>
        <Name>Copywriting</Name>
      </Task>
      <Staff>
        <UUID>a6d22d8b-752b-4b50-854f-8ca5559061b4</UUID>
        <Name>John Smith</Name>
      </Staff>
      <Date>2008-11-04T00:00:00</Date>
      <Minutes>180</Minutes>
      <Note />
      <Billable>true</Billable>
    </Time>
  </Times>
</Response>
```


## GET list


Return a list of time sheet entries. The maximum date range between the from and to parameters is one year

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| from=YYYYMMDD | Required | Return time sheet entries created on or after this date. |
| to=YYYYMMDD | Required | Return time sheet entries created on or before this date. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/time.api/list?from=20090801&to=20090901
```


## GET staff/\[uuid\]


Return a list of time sheet entries for a specific staff member

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| from=YYYYMMDD | Required | Return time sheet entries created on or after this date. |
| to=YYYYMMDD | Required | Return time sheet entries created on or before this date. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/time.api/staff/f8235e1a-d383-48b7-9139-ba97ab8ca889?from=20090801&to=20090901
```


## GET get/\[uuid\]


Detailed information for a specific time entry

### Example URL

```
https://api.xero.com/practicemanager/3.1/time.api/get/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Time>
    <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
    <Job>
      <ID>J000001</ID>
      <Name>Brochure Template</Name>
    </Job>
    <Task>
      <UUID>faabafbe-1a8c-4172-b4a5-d989dda44ab5</UUID>
      <Name>Design &amp; Layout</Name>
    </Task>
    <Staff>
      <UUID>c2014300-12a3-4d98-9b83-0ff84ae1c72b</UUID>
      <Name>Chris Spence </Name>
    </Staff>
    <Date>2008-10-29T00:00:00</Date>
    <Minutes>240</Minutes>
    <Note />
    <Billable>true</Billable>
    <!-- below values are included if the time entry was record with a start and end time -->
    <Start>13:00</Start>
    <End>17:00</End>
    <InvoiceTaskUUID /> <!-- if time was invoiced -->
  </Time>
</Response>
```


## POST add


Add a time sheet entry to a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/time.api/add
```


### Example Message for adding a time sheet entry by duration

```
<Timesheet>
  <Job>J000309</Job>
  <TaskUUID>f73c82da-c1f3-4fa2-b2c3-eaa6397d300b</TaskUUID>
  <StaffUUID>fa0cb4d8-9b7f-42db-8b89-596681519afa</StaffUUID>
  <Date>20081030</Date>
  <Minutes>60</Minutes>
  <Note>Detailed note about the time sheet entry</Note>
</Timesheet>
```


### Example Message for adding a time sheet entry by duration – negative time

```
<Timesheet>
  <Job>J000310</Job>
  <TaskUUID>f73c82da-c1f3-4fa2-b2c3-eaa6397d300b</TaskUUID>
  <StaffUUID>fa0cb4d8-9b7f-42db-8b89-596681519afa</StaffUUID>
  <Date>20141030</Date>
  <Minutes>-60</Minutes>
  <Note>Negative time entry</Note>
</Timesheet>
```


### Example Message for adding a time sheet entry by start/end time

```
<Timesheet>
  <Job>J000311</Job>
  <TaskUUID>f73c82da-c1f3-4fa2-b2c3-eaa6397d300b</TaskUUID>
  <StaffUUID>fa0cb4d8-9b7f-42db-8b89-596681519afa</StaffUUID>
  <Date>20081030</Date>
  <Start>13:00</Start>
  <End>13:30</End>
  <Note>Detailed note about the time sheet entry</Note>
</Timesheet>
```


The response will include the detailed information of the time entry per the GET get/\[identifier\] method

## PUT update


Update a time sheet entry on a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/time.api/update
```


### Example Message for updating a time sheet entry by duration

```
<Timesheet>
  <UUID>f5d334b2-c07f-424c-89b4-2c2aabc09edd</UUID>
  <Job>J000309</Job>
  <TaskUUID>f73c82da-c1f3-4fa2-b2c3-eaa6397d300b</TaskUUID>
  <StaffUUID>fa0cb4d8-9b7f-42db-8b89-596681519afa</StaffUUID>
  <Date>20081030</Date>
  <Minutes>60</Minutes>
  <Note>Detailed note about the time sheet entry</Note>
</Timesheet>
```


### Example Message for updating a time sheet entry by duration – negative time

```
<Timesheet>
  <UUID>690cf982-1ca1-4c9e-a05c-a1029b921c57</UUID>
  <Job>J000310</Job>
  <TaskUUID>f73c82da-c1f3-4fa2-b2c3-eaa6397d300b</TaskUUID>
  <StaffUUID>fa0cb4d8-9b7f-42db-8b89-596681519afa</StaffUUID>
  <Date>20141030</Date>
  <Minutes>-60</Minutes>
  <Note>Negative time entry</Note>
</Timesheet>
```


### Example Message for updating a time sheet entry by start/end time

```
<Timesheet>
  <UUID>f5d334b2-c07f-424c-89b4-2c2aabc09edd</UUID>
  <Job>J000311</Job>
  <TaskUUID>f73c82da-c1f3-4fa2-b2c3-eaa6397d300b</TaskUUID>
  <StaffUUID>fa0cb4d8-9b7f-42db-8b89-596681519afa</StaffUUID>
  <Date>20081030</Date>
  <Start>13:00</Start>
  <End>13:30</End>
  <Note>Detailed note about the time sheet entry</Note>
</Timesheet>
```


The response will include the detailed information of the time entry per the GET get/\[identifier\] method

## DELETE delete/\[uuid\]


Delete a specific time sheet entry

### Example URL

```
https://api.xero.com/practicemanager/3.1/time.api/delete/f8235e1a-d383-48b7-9139-ba97ab8ca889
```
