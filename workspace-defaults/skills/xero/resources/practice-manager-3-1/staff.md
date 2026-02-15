# Staff

| Endpoint | Description |
| --- | --- |
| GET list | Return a list of all staff members |
| [GET get/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/staff#get-getuuid) | Details for a specific staff member |
| POST add | Add a staff member |
| PUT update | Update a staff members details |
| POST delete | Delete a staff member |
| POST enable | Enable a staff member so they can log into Practice Manager |
| POST disable | Disable a staff member so they can no longer log into Practice Manager |
| POST forgottenpassword | Reset a staff members password. The staff member will be sent an email to reset their password. This is the same as the staff member using the Forgotten Password process. |

## GET list


Return a list of all staff members

### Example URL

```
https://api.xero.com/practicemanager/3.1/staff.api/list
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <StaffList>
    <Staff>
      <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
      <Name>Jo Bloggs</Name>
      <Email>jo@bloggs.net</Email>
      <Phone />
      <Mobile />
      <Address />
      <PayrollCode />
    </Staff>
    <Staff>
      <UUID>0cbaf41f-9241-4f72-8b90-fbdf4457c346</UUID>
      <Name>John Smith</Name>
      <Email>john@smith.com</Email>
      <Phone />
      <Mobile />
      <Address />
      <PayrollCode />
    </Staff>
  </StaffList>
</Response>
```


## GET get/\[uuid\]


Details for a specific staff member

### Example URL

```
https://api.xero.com/practicemanager/3.1/staff.api/get/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <WebUrl>https://app.practicemanager.xero.com/admin/resourceedit.aspx?id=123</WebUrl>
  <Staff>
    <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
    <Name>Jo Bloggs</Name>
    <Email>jo@bloggs.net</Email>
    <Phone />
    <Mobile />
    <Address />
    <PayrollCode />
  </Staff>
</Response>
```


## POST add


Add a staff member

### Example URL

```
https://api.xero.com/practicemanager/3.1/staff.api/add
```


### Example Message

```
<Staff>
  <Name>John Smith</Name>
  <Address></Address>  <!-- optional -->
  <Phone></Phone>  <!-- optional -->
  <Mobile></Mobile>  <!-- optional -->
  <Email></Email>  <!-- optional -->
  <PayrollCode></PayrollCode>  <!-- optional -->
</Staff>
```


The response will include the detailed information of the staff member as per the GET get/\[identifier\] method

## PUT update


Update a staff members details

### Example URL

```
https://api.xero.com/practicemanager/3.1/staff.api/update
```


### Example Message

```
<Staff>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
  <Name>John Smith</Name>
  <Address></Address>  <!-- optional -->
  <Phone></Phone>  <!-- optional -->
  <Mobile></Mobile>  <!-- optional -->
  <Email></Email>  <!-- optional -->
  <PayrollCode></PayrollCode>  <!-- optional -->
</Staff>
```


The response will include the detailed information of the staff member as per the GET get/\[identifier\] method

## POST delete


Delete a staff member

### Example URL

```
https://api.xero.com/practicemanager/3.1/staff.api/delete
```


### Example Message

```
<Staff>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
</Staff>
```


## POST enable


Enable a staff member so they can log into Practice Manager

### Example URL

```
https://api.xero.com/practicemanager/3.1/staff.api/enable
```


### Example Message

```
<Staff>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
  <Security>
  </Security>
</Staff>
```


## POST disable


Disable a staff member so they can no longer log into Practice Manager

### Example URL

```
https://api.xero.com/practicemanager/3.1/staff.api/disable
```


### Example Message

```
<Staff>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
</Staff>
```


## POST forgottenpassword


Reset a staff members password. The staff member will be sent an email to reset their password. This is the same as the staff member using the Forgotten Password process.

### Example URL

```
https://api.xero.com/practicemanager/3.1/staff.api/forgottenpassword
```


### Example Message

```
<Staff>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
</Staff>
```
