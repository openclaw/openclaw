# Jobs

| Endpoint | Description |
| --- | --- |
| GET current | Returns a list of current jobs |
| [GET get/\[job number\]](https://developer.xero.com/documentation/api/practice-manager-3-1/jobs#get-getjob-number) | Detailed information for a specific job |
| PUT state | Update the state of a specific job |
| GET list | Return a list of all jobs |
| [GET staff/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/jobs#get-staffuuid) | Return a list of all current jobs assigned to a staff member |
| [GET client/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/jobs#get-clientuuid) | Return a list of all jobs assigned for a specific client |
| GET tasks | Return a list of jobs and their tasks matching the specified criteria |
| POST add | Add a job |
| PUT update | Update a job |
| POST task | Add a task to a job |
| PUT task | Update a task on a job |
| [PUT task/\[uuid\]/complete](https://developer.xero.com/documentation/api/practice-manager-3-1/jobs#put-taskuuidcomplete) | Complete a task on a job |
| [PUT task/\[uuid\]/reopen](https://developer.xero.com/documentation/api/practice-manager-3-1/jobs#put-taskuuidreopen) | Re-open a task on a job |
| PUT reordertasks | Reorder the tasks on a job |
| POST note | Add a note to a job |
| [GET documents/\[job number\]](https://developer.xero.com/documentation/api/practice-manager-3-1/jobs#get-documentsjob-number) | Return a list of documents for a job |
| POST document | Add a document to a job |
| [GET costs/\[job number\]](https://developer.xero.com/documentation/api/practice-manager-3-1/jobs#get-costsjob-number) | Return a list of costs for a job |
| POST cost | Add a cost to a job |
| PUT cost | Update a cost on a job |
| PUT assign | Assign staff to a job |
| POST delete | Delete a job |
| POST applytemplate | Apply an additional template to a job |
| [POST createquote/\[job number\]](https://developer.xero.com/documentation/api/practice-manager-3-1/jobs#post-createquotejob-number) | Create a quote based on the job |
| [POST createestimate/\[job number\]](https://developer.xero.com/documentation/api/practice-manager-3-1/jobs#post-createestimatejob-number) | Create an estimate based on the job |

## GET current


Returns a list of current jobs

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| detailed=true | Optional | Return detailed information on invoice. See GET get/\[job number\] method for example of detailed job response. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/current
```


### Example Response

```
<Response>
<Status>OK</Status>
 <Jobs>
   <Job>
     <ID>J000159</ID>
     <Name>Brochure Design</Name>
     <Description />
     <State>Planned</State>
     <ClientOrderNumber />
     <StartDate>2007-09-15T00:00:00</StartDate>
     <DueDate>2007-09-22T00:00:00</DueDate>
     <CompletedDate>2007-09-22T00:00:00</CompletedDate>
     <Client>
       <UUID>ffefa0e3-d454-4a1b-8811-b07df638f95e</UUID>
       <Name>A C Smith Limited</Name>
     </Client>
     <Contact>
       <UUID>0bbe6620-1e06-45d2-846b-d1ff15d03b19</UUID>
       <Name>John Smith</Name>
     </Contact>
     <Manager>
       <UUID>4c624afa-b72e-4ad6-9c80-8a91537899fd</UUID>
       <Name>John Smith</Name>
     </Manager>
     <Partner>
       <UUID>32b7e056-896a-49f0-ba59-58694ce2b31f</UUID>
       <Name>Jack Brown</Name>
     </Partner>
     <Assigned>
       <Staff>
         <UUID>1f8a7853-148d-4f74-ada0-d8eaf6ae87d3</UUID>
         <Name>Jo Bloggs</Name>
       </Staff>
     </Assigned>
   </Job>
   <Job>
     <ID>J000232</ID>
     <Name>Custom Development</Name>
     <Description />
     <State>Planned</State>
     <ClientOrderNumber />
     <StartDate>2008-08-06T00:00:00</StartDate>
     <DueDate>2008-08-29T00:00:00</DueDate>
     <Client>
       <UUID>c66cb067-bc16-4fa3-b54e-5ee9bf95b7e2</UUID>
       <Name>Robert Holdings</Name>
     </Client>
     <Contact>
       <UUID>d8322568-c2c6-47e2-a99d-acf547e02124</UUID>
       <Name>John Roberts</Name>
     </Contact>
     <Assigned>
       <Staff>
        <UUID>af95b222-94d3-4285-b461-3fa1478f18e2</UUID>
        <Name>Jo Bloggs</Name>
       </Staff>
     </Assigned>
   </Job>
 </Jobs>
</Response>
```


## GET get/\[job number\]


Detailed information for a specific job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/get/J00309
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <WebUrl>https://app.practicemanager.xero.com/job/jobview.aspx?id=J000309</WebUrl>
  <Job>
    <ID>J000309</ID>
    <UUID>0d3458b8-6fde-4389-8dbb-0a85804466ad</UUID>
    <Name>job name</Name>
    <Description>description of job</Description>
    <State>Planned</State>
    <ClientOrderNumber />
    <Budget>55.00</Budget>
    <Type>Website Development</Type>
    <StartDate>2008-08-29T00:00:00</StartDate>
    <DueDate>2008-09-29T00:00:00</DueDate>
    <CompletedDate>2008-09-29T00:00:00</CompletedDate>
    <Client>
      <UUID>210acbff-4dca-4524-a956-ad9ea5d6dbf1</UUID>
      <Name>The Health Company</Name>
    </Client>
    <Contact>
      <UUID>e585e0e6-0592-4f1a-b897-6c0c282441f0</UUID>
      <Name>Shelley Brio</Name>
    </Contact>
    <Manager>
      <UUID>a1981f48-dc1b-456a-925b-918fa099fd42</UUID>
      <Name>John Smith</Name>
    </Manager>
    <Partner>
      <UUID>8f60d525-75b9-4d2b-b451-14e7f718b6ef</UUID>
      <Name>Jack Brown</Name>
    </Partner>
    <Assigned>
      <Staff>
        <UUID>af6f1a4a-3929-41ef-b344-68765c9d4db7</UUID>
        <Name>Jo Bloggs</Name>
      </Staff>
     </Assigned>
    <Tasks>
      <Task>
        <UUID>af6f1a4a-3929-41ef-b344-68765c9d4db7</UUID>
        <TaskUUID>f4f62087-e131-4089-be4e-28ba8b6bd3e1</TaskUUID>
        <Name>Creative Direction</Name>
        <Description />
        <EstimatedMinutes>180</EstimatedMinutes>
        <ActualMinutes>100</ActualMinutes>
        <Completed>false</Completed>
        <Billable>true</Billable>
        <Folder />
        <!-- if the task has been scheduled the following will be present -->
        <StartDate>2008-08-29T00:00:00</StartDate>
        <DueDate>2008-09-29T00:00:00</DueDate>
        <Assigned>
          <Staff>
            <UUID>68ae87b9-8268-4fe0-a65d-c0e2ddb3d9a5</UUID>
            <Name>Jo Blogs</Name>
            <AllocatedMinutes>180</AllocatedMinutes>
          </Staff>
        </Assigned>
      </Task>
      <Task>
        <UUID>df824169-20a6-4e4e-a261-d106d0543452</UUID>
        <TaskUUID>58fc352f-e65b-4c07-8ce5-47386583201f</TaskUUID>
        <Name>Design &amp; Layout</Name>
        <Description />
        <EstimatedMinutes>120</EstimatedMinutes>
        <ActualMinutes>180</ActualMinutes>
        <Completed>false</Completed>
        <Billable>true</Billable>
        <Folder />
      </Task>
    </Tasks>
    <Milestones>
      <Milestone>
        <UUID>f252ae9b-da45-43a4-8fd2-cba0e4a79cb5</UUID>
        <Date>2008-09-24T00:00:00</Date>
        <Description>do something by then</Description>
        <Completed>false</Completed>
        <Folder />
      </Milestone>
    </Milestones>
    <Notes>
      <Note>
        <UUID>bdcb3407-9ef5-4dd0-8a1b-0710af0342f1</UUID>
        <Title>note title</Title>
        <Text>subject of the note</Text>
        <Folder />
        <Date>2008-09-12T13:00:00</Date>
        <CreatedBy>Jo Bloggs</CreatedBy>
        <Comments>
          <Comment>
            <UUID>128d63fe-f494-47fb-a815-e2ecbbc7aa0d</UUID>
            <Text>example comment</Text>
            <Date>2008-09-12T14:00:00</Date>
            <CreatedBy>John Smith</CreatedBy>
          </Comment>
        </Comments>
      </Note>
    </Notes>
  </Job>
</Response>
```


## PUT state


Update the state of a specific job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/state
```


### Example Message

```
<Job>
  <ID>J000309</ID>
  <UUID>0d3458b8-6fde-4389-8dbb-0a85804466ad</UUID>
  <!-- The value of the state element is that in the Interface Code field for each Job State as defined in Admin -->
  <State>CONFIRMED</State>
</Job>
```


## GET list


Return a list of all jobs. The maximum date range between the from and to parameters is one year

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| from=YYYYMMDD | Required | Return jobs created on or after this date. |
| to=YYYYMMDD | Required | Return jobs created on or before this date. |
| detailed=true | Optional | Return detailed information on job. See GET get/\[job number\] method for example of detailed job response. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/list?from=20090801&to=20090901
```


## GET staff/\[uuid\]


Return a list of all current jobs assigned to a staff member

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/staff/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


## GET client/\[uuid\]


Return a list of all jobs assigned for a specific client

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/client/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


## GET tasks


Return a list of jobs and their tasks matching the specified criteria

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| complete=true \| false | Optional | Return jobs containing completed or uncompleted tasks only |
| due=YYYYMMDD | Optional | Return jobs with tasks due on or before this date. |
| start=YYYYMMDD | Optional | Return jobs with tasks starting on of after this date. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/tasks?due=20090801&complete=false
```


## POST add


Add a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/add
```


### Example Message

```
<Job>
  <Name>Brochure Design</Name>
  <Description>Detailed description of the job</Description>

  <ClientUUID>dea92ac7-d536-402d-9447-7875020499be</ClientUUID>
  <ContactUUID>17c83eef-993c-4aa6-a980-9cfbd054702b</ContactUUID>    <!-- optional -->
  <StartDate>20091023</StartDate>
  <DueDate>20091028</DueDate>
  <ClientNumber>client order number</ClientNumber>  <!-- optional -->

  <!-- Optional – Use to assign a custom ID to the job.  If not specified, the next value from the job number sequence will be used.  -->
  <ID>ABC123</ID>

  <!-- ID of Job Template to apply to job.  Applying a template allows you to default the job milestones, tasks and costs -->
  <TemplateUUID>3f863a3b-87ce-4ccb-a112-98a068a3a159</TemplateUUID>  <!-- optional -->
  <!-- ID of Job Category to assign to job -->
  <CategoryUUID />  <!-- optional -->
  <Budget>55.00</Budget> <!-- optional -->
</Job>
```


The response will include the detailed information of the job as per the GET get/\[job number\] method

## PUT update


Update a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/update
```


### Example Message

```
<Job>
  <ID>J000123</ID>
  <Name>Brochure Design</Name>
  <Description>Detailed description of the job</Description>
  <StartDate>20091023</StartDate>
  <DueDate>20091028</DueDate>
  <ClientNumber>client order number</ClientNumber>  <!-- optional -->

  <!-- ID of Job Category to assign to job -->
  <CategoryID />  <!-- optional -->
  <Budget>55.00</Budget> <!-- optional -->
</Job>
```


The response will include the detailed information of the job as per the GET get/\[job number\] method

## POST task


Add a task to a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/task
```


### Example Message

```
<Task>
  <Job>J000309</Job>
  <TaskUUID>268a7247-a3b7-4f12-811d-19960493b901</TaskUUID>    <!-- refer Task Methods for obtaining list of tasks and their IDs -->
  <Label></Label>    <!-- optional -->
  <Description></Description>    <!-- optional -->
  <EstimatedMinutes>60</EstimatedMinutes>
  <StartDate>20091023</StartDate>    <!-- optional -->
  <DueDate>20091028</DueDate>    <!-- optional -->
</Task>
```


## PUT task


Update a task on a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/task
```


### Example Message

```
<Task>
  <TaskUUID>41ea0acc-5147-407b-9f56-2445713403af</UUID>
  <Label></Label>    <!-- optional -->
  <Description></Description>    <!-- optional -->
  <EstimatedMinutes>60</EstimatedMinutes>
  <StartDate>20091023</StartDate>    <!-- optional -->
  <DueDate>20091028</DueDate>    <!-- optional -->
</Task>
```


## PUT task/\[uuid\]/complete


Complete a task on a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/task/f8235e1a-d383-48b7-9139-ba97ab8ca889/complete
```


## PUT task/\[uuid\]/reopen


Re-open a task on a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/task/f8235e1a-d383-48b7-9139-ba97ab8ca889/reopen
```


## PUT reordertasks


Reorder the tasks on a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/reordertasks
```


### Example Message

```
<Job>
  <ID>J000123</ID>
  <Tasks>
    <Task>
      <UUID>f3e8040f-43b8-452f-a9a2-700936c03f30</UUID>
    </Task>
    <Task>
      <UUID>166932dd-33d9-4222-a564-2ba9f67a6a31</UUID>
    </Task>
    <Task>
      <UUID>9e1ad380-77a6-4321-a7ce-8f3dc6379496</UUID>
    </Task>
  </Tasks>
</Job>
```


## POST note


Add a note to a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/note
```


### Example Message

```
<Note>
  <Job>J000309</Job>
  <Title>Note Title</Title>
  <Text>The text relating to the note</Text>
  <Folder>Correspondence</Folder>    <!-- optional -->
  <Public>false</Public>    <!-- optional true | false -->
</Note>
```


## GET documents/\[job number\]


Return a list of documents for a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/documents/J00309
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
    <FileName>file.txt</FileName>
    <URL>https://practicemanager.xero.com/....... </URL>
  </Document>
</Documents>
```


## POST document


Add a document to a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/document
```


### Example Message

```
<Document>
  <Job>J000309</Job>
  <Title>Document Title</Title>
  <Text>The note relating to the document</Text>
  <Folder>Images</Folder>    <!-- optional -->
  <Public>false</Public>    <!-- optional true | false -->
  <FileName>example.jpg</FileName>
  <Content>File content base 64 encoded</Content>
</Document>
```


## GET costs/\[job number\]


Return a list of costs for a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/costs/J00309
```


### Example Response

```
<Costs>
  <Cost>
    <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
    <Date>2009-10-23T00:00:00</Date>
    <Description>Widget</Description>
    <Code>WIDGET</Code>
    <Note>a note about the widget</Note>
    <Quantity>1</Quantity>
    <UnitCost>50.00</UnitCost>
    <UnitPrice>100.00</UnitPrice>
    <Billable>true</Billable> <!-- true | false -->
  </Cost>
</Costs>
```


## POST cost


Add a cost to a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/cost
```


### Example Message

```
<Cost>
  <Job>J000309</Job>
  <Date>20091023</Date>
  <Description>Widget</Description>
  <Code>WIDGET</Code>    <!-- optional -->
  <Note>a note about the widget</Note>    <!-- optional -->
  <Quantity>1</Quantity>
  <UnitCost>50.00</UnitCost>
  <UnitPrice>100.00</UnitPrice>
  <Billable>true</Billable>    <!-- optional true (default) | false -->
</Cost>
```


## PUT cost


Update a cost on a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/cost
```


### Example Message

```
<Cost>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
  <Date>20091023</Date>
  <Description>Widget</Description>
  <Code>WIDGET</Code>    <!-- optional -->
  <Note>a note about the widget</Note>    <!-- optional -->
  <Quantity>1</Quantity>
  <UnitCost>50.00</UnitCost>
  <UnitPrice>100.00</UnitPrice>
  <Billable>true</Billabler>    <!-- optional true (default) | false -->
</Cost>
```


## PUT assign


Assign staff to a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/assign
```


### Example Message

```
<Job>
  <ID>J000309</ID>
  <UUID>0d3458b8-6fde-4389-8dbb-0a85804466ad</UUID>
  <add uuid="96c200ce-1dd7-4b38-9830-9dc43c06e076"/>     <!-- uuid = UUID of staff member -->
  <remove uuid="a75a5ace-a861-431a-9fe2-f5b6bf9d6692"/>
  <add uuid="d25b6db1-eb89-4570-94b2-4ec9ef725217" task-uuid="0d8a4376-ede7-491e-8044-f62fbdd2d258" />     <!-- assign staff to a specific task -->
  <remove id="79e380a8-dfb8-4c7d-8d9c-d37a6bf212fe" task-uuid="3a0fa5a4-9c0d-4419-a9cc-adac9047c029"/>   <!-- remove staff from a specific task -->

  <!-- the following elements allow you to assign a manager to the job -->
  <add-manager uuid="229a78d7-bb45-49ca-946c-35187c1185df"/>     <!-- uuid = UUID of staff member -->
  <remove-manager />
  <!-- the following elements allow you to assign a partner/account manager to the job -->
  <add-partner uuid="eaa09364-1f08-4e31-82e8-d94715a8b556"/>     <!-- uuid = UUID of staff member -->
  <remove-partner />
</Job>
```


## POST delete


Delete a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/delete
```


### Example Message

```
<Job>
  <ID>J000309</ID>
  <UUID>0d3458b8-6fde-4389-8dbb-0a85804466ad</UUID>
</Job>
```


## POST applytemplate


Apply an additional template to a job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/applytemplate
```


### Example Message

```
<Job>
  <ID>J000309</ID>
  <UUID>0d3458b8-6fde-4389-8dbb-0a85804466ad</UUID>
  <TemplateUUID>3479eee3-e9c8-46e4-ac65-8e4f1719b309</TemplateUUID>  <!-- ID of Job Template to apply to job -->
  <!-- TaskMode describes how tasks are added to the job
       AddNew: tasks are always added to the job (default)
       AppendExisting: where the same task already exists on the job, the template task will be appended to the details of the existing task, otherwise the task will be added to the job
  -->
  <TaskMode>AddNew</TaskMode>
</Job>
```


## POST createquote/\[job number\]


Create a quote based on the job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/createquote/J00309
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <ID>Q000123</ID>   <!-- ID of the newly created quote -->
</Response>
```


## POST createestimate/\[job number\]


Create an estimate based on the job

### Example URL

```
https://api.xero.com/practicemanager/3.1/job.api/createestimate/J00309
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <ID>Q000123</ID>   <!-- ID of the newly created estimate -->
</Response>
```
